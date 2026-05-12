#!/bin/bash
# clip-fetch.sh — 微信公众号文章抓取脚本
# 用法: bash clip-fetch.sh <URL> [输出目录]
# 输出: JSON 到 stdout（在 OUTPUT_JSON_START/END 之间）
# 任何退出路径都保证输出 JSON（通过 trap）

# ── 全局 trap：保证任何退出都有 JSON 输出 ──
OUTPUT_JSON=""
cleanup() {
  # 清理临时目录（如果已创建）
  if [ -n "${TMP_JSON_DIR:-}" ] && [ -d "${TMP_JSON_DIR}" ]; then
    rm -rf "$TMP_JSON_DIR" 2>/dev/null || true
  fi
  if [ -z "$OUTPUT_JSON" ]; then
    echo ""
    echo "========== OUTPUT_JSON_START =========="
    echo '{"error":"脚本异常退出，请检查 Claudian 浏览器模式是否启用后重试","errorType":"unexpected_exit"}'
    echo "========== OUTPUT_JSON_END =========="
    echo ""
  fi
}
trap cleanup EXIT

# 不用 set -e，手动处理每个错误
CDP_PORT="${CDP_PORT:-3456}"
URL="${1:?用法: bash clip-fetch.sh <URL> [输出目录]}"
VAULT_DIR="${2:-$(pwd)}"
IMG_BASE_DIR="${VAULT_DIR}/04-assets/images"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STEP4_JS="${SCRIPT_DIR}/clip-html2md.js"

# ── 0. 检查 CDP（自动启动 proxy，重试等待）──
CDP_OK=false

# 先快速检测：proxy 已在运行且已连接 Chrome？
CDP_RESP=$(curl -s --max-time 3 "http://localhost:${CDP_PORT}/health" 2>/dev/null) || true
if echo "$CDP_RESP" | jq -e '.status == "ok" and .connected == true' > /dev/null 2>&1; then
  CDP_OK=true
elif echo "$CDP_RESP" | jq -e '.status == "ok"' > /dev/null 2>&1; then
  # Proxy 在运行但未连接 Chrome（connected 为 null/false）→ 杀掉后重启
  echo "   ⚠️ CDP Proxy 在运行但未连接 Chrome，重启中..."
  pkill -f "cdp-proxy.mjs" 2>/dev/null || true
  sleep 1
fi

# proxy 未运行 → 尝试自动启动（使用 web-access skill 的 check-deps.mjs）
if [ "$CDP_OK" = false ]; then
  CHECK_DEPS="${SCRIPT_DIR}/cdp-proxy/check-deps.mjs"
  if [ -f "$CHECK_DEPS" ]; then
    echo "   ⚡ CDP Proxy 未运行，自动启动中..."
    CHECK_OUTPUT=$(node "$CHECK_DEPS" 2>&1) || true
    # check-deps 会自动启动 proxy 并等待就绪，最多 ~20 秒
    sleep 2
  fi

  # 重试检测（最多 5 次，间隔 3 秒）
  for attempt in 1 2 3 4 5; do
    CDP_RESP=$(curl -s --max-time 5 "http://localhost:${CDP_PORT}/health" 2>/dev/null) || true
    if echo "$CDP_RESP" | jq -e '.status == "ok"' > /dev/null 2>&1; then
      CDP_OK=true
      break
    fi
    [ $attempt -lt 5 ] && sleep 3
  done
fi

if [ "$CDP_OK" = false ]; then
  echo "❌ CDP 连接失败。请确认：1) Chrome 已打开 2) 已在 chrome://inspect 勾选远程调试 3) 端口 ${CDP_PORT} 可访问"
  echo "   提示：可手动运行 node ~/.claude/skills/web-access/scripts/check-deps.mjs 检查环境"
  OUTPUT_JSON='{"error":"CDP 连接失败。请确认：1) Chrome 已打开 2) 已在 chrome://inspect 勾选远程调试 3) 端口 '"${CDP_PORT}"' 可访问","errorType":"cdp_unavailable"}'
  echo ""
  echo "========== OUTPUT_JSON_START =========="
  echo "$OUTPUT_JSON"
  echo "========== OUTPUT_JSON_END =========="
  exit 1
fi

# ── 1. 打开页面（静默）──
ENCODED_URL=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$URL" 2>/dev/null) || ENCODED_URL="$URL"
TAB_INFO=$(curl -s --max-time 15 "http://localhost:${CDP_PORT}/new?url=${ENCODED_URL}" 2>/dev/null) || TAB_INFO=""

TAB_ID=$(echo "$TAB_INFO" | jq -r '.targetId // .id // .target // empty' 2>/dev/null)

if [ -z "$TAB_ID" ]; then
  # 兜底：从返回中 grep 十六进制 ID
  TAB_ID=$(echo "$TAB_INFO" | grep -oE '[A-F0-9]{32}' | head -1 || true)
fi

if [ -z "$TAB_ID" ]; then
  echo "❌ 无法创建浏览器标签页。请检查 URL 是否正确：${URL}"
  OUTPUT_JSON="{\"error\":\"无法创建浏览器标签页。请检查 URL 是否正确：${URL}\",\"errorType\":\"tab_creation_failed\"}"
  echo ""
  echo "========== OUTPUT_JSON_START =========="
  echo "$OUTPUT_JSON"
  echo "========== OUTPUT_JSON_END =========="
  exit 1
fi

# ── 2. 等待页面加载 + 滚动触发懒加载（静默）──
sleep 3
curl -s --max-time 10 "http://localhost:${CDP_PORT}/scroll?target=${TAB_ID}&direction=bottom" > /dev/null 2>&1 || true
sleep 2
curl -s --max-time 10 "http://localhost:${CDP_PORT}/scroll?target=${TAB_ID}&direction=bottom" > /dev/null 2>&1 || true
sleep 1

# ── 辅助函数：执行 JS eval（带超时保护）──
# Claudian 的 /eval 返回 {"value": ...}，这里解一层取出实际值
# 支持 -d 直接传 JS 字符串，或 --file 从文件读取（用于大段 JS）
# 返回值通过全局变量 SAFE_EVAL_OK 标识是否成功（0=成功, 1=失败/空）
SAFE_EVAL_OK=0
safe_eval() {
  local target="$1"
  local js="$2"
  local timeout="${3:-30}"
  local raw
  SAFE_EVAL_OK=0
  if [ "$js" = "--file" ]; then
    shift 2; local jsfile="$1"; timeout="${2:-30}"
    raw=$(curl -s --max-time "$timeout" -X POST "http://localhost:${CDP_PORT}/eval?target=${target}" --data-binary @"$jsfile" 2>/dev/null) || raw='{"error":"eval_timeout"}'
  else
    raw=$(curl -s --max-time "$timeout" -X POST "http://localhost:${CDP_PORT}/eval?target=${target}" -d "$js" 2>/dev/null) || raw='{"error":"eval_timeout"}'
  fi
  local result
  result=$(echo "$raw" | jq -r '.value // . // empty' 2>/dev/null)
  # 空值检查：如果结果为空或 null，标记为失败（静默失败比报错更危险）
  if [ -z "$result" ] || [ "$result" = "null" ] || [ "$result" = "" ]; then
    SAFE_EVAL_OK=1
    # 返回原始错误信息以便上层诊断
    echo "$raw" | jq -r '.error // . // "empty_response"' 2>/dev/null
    return
  fi
  echo "$result"
}

# ── 3. 提取元数据（标题、作者、公众号）──
META=$(safe_eval "$TAB_ID" '
(function(){
  var _a = document.querySelector("#js_author_name_text")?.innerText || "";
  if (!_a) _a = document.querySelector("#js_author_name")?.innerText || "";
  if (!_a) _a = document.querySelector("#js_name")?.innerText || "";
  var _acct = document.querySelector("#js_name")?.innerText || "";
  var _biz = typeof window.biz !== "undefined" ? window.biz : "";
  return JSON.stringify({
    title: document.querySelector("#activity-name")?.innerText || "",
    author: _a,
    account: _acct,
    accountUrl: _biz ? "https://mp.weixin.qq.com/mp/profile_ext?action=home&__biz=" + encodeURIComponent(_biz) + "&scene=124#wechat_redirect" : "",
    publishDate: document.querySelector("#publish_time")?.innerText || ""
  });
})()')

if [ "$SAFE_EVAL_OK" -ne 0 ]; then
  echo "❌ 提取元数据失败（eval 返回空值）：${META}"
  OUTPUT_JSON="{\"error\":\"提取元数据失败（eval 返回空值）：${META}\",\"errorType\":\"meta_extract_failed\"}"
  echo ""
  echo "========== OUTPUT_JSON_START =========="
  echo "$OUTPUT_JSON"
  echo "========== OUTPUT_JSON_END =========="
  exit 1
fi

META_ERR=$(echo "$META" | jq -r '.error // empty' 2>/dev/null)
if [ -n "$META_ERR" ]; then
  echo "❌ 提取元数据失败：${META_ERR}"
  OUTPUT_JSON="{\"error\":\"提取元数据失败：${META_ERR}\",\"errorType\":\"meta_extract_failed\"}"
  echo ""
  echo "========== OUTPUT_JSON_START =========="
  echo "$OUTPUT_JSON"
  echo "========== OUTPUT_JSON_END =========="
  exit 1
fi

# 额外检查 META 是否为合法 JSON（防止 CDP 返回了非 JSON 内容）
if ! echo "$META" | jq -e '.' > /dev/null 2>&1; then
  echo "❌ 提取元数据失败（返回非法 JSON）：${META:0:200}"
  OUTPUT_JSON="{\"error\":\"提取元数据失败（返回非法 JSON）：${META:0:200}\",\"errorType\":\"meta_extract_invalid\"}"
  echo ""
  echo "========== OUTPUT_JSON_START =========="
  echo "$OUTPUT_JSON"
  echo "========== OUTPUT_JSON_END =========="
  exit 1
fi

TITLE=$(echo "$META" | jq -r '.title // "未知标题"' 2>/dev/null)
AUTHOR=$(echo "$META" | jq -r '.author // "未知作者"' 2>/dev/null)
ACCOUNT=$(echo "$META" | jq -r '.account // ""' 2>/dev/null)
ACCOUNT_URL=$(echo "$META" | jq -r '.accountUrl // ""' 2>/dev/null)
PUB_DATE=$(echo "$META" | jq -r '.publishDate // ""' 2>/dev/null)

# ── 首行输出：让用户知道正在处理什么文章 ──
echo "📖 ${TITLE}（${AUTHOR}）"

# ── 4. 提取正文 + 图片占位符 + 图片映射（静默）──
# 使用独立文件 clip-html2md.js，通过 --data-binary @file 传递给 CDP /eval
CONTENT=$(safe_eval "$TAB_ID" --file "$STEP4_JS" 120)

if [ "$SAFE_EVAL_OK" -ne 0 ]; then
  echo "❌ 提取正文失败（eval 返回空值）：${CONTENT}"
  OUTPUT_JSON="{\"error\":\"提取正文失败（eval 返回空值）：${CONTENT}\",\"errorType\":\"content_extract_failed\"}"
  echo ""
  echo "========== OUTPUT_JSON_START =========="
  echo "$OUTPUT_JSON"
  echo "========== OUTPUT_JSON_END =========="
  exit 1
fi

CONTENT_ERR=$(echo "$CONTENT" | jq -r '.error // empty' 2>/dev/null)
if [ -n "$CONTENT_ERR" ]; then
  echo "❌ 提取正文失败：${CONTENT_ERR}"
  OUTPUT_JSON="{\"error\":\"提取正文失败：${CONTENT_ERR}\",\"errorType\":\"content_extract_failed\"}"
  echo ""
  echo "========== OUTPUT_JSON_START =========="
  echo "$OUTPUT_JSON"
  echo "========== OUTPUT_JSON_END =========="
  exit 1
fi

TEXT_BODY=$(echo "$CONTENT" | jq -r '.text // ""' 2>/dev/null)

# ── 正文后处理：修复章节标题层级 ──
# 问题：微信文章中作者手打的 "# 标题" 被当成正文，且经常粘在上一段末尾
# 注意：htmlToMarkdown 已经输出了正确的 ### 标题，这里只处理手打的 # 标题
# 修复：1) 段落末尾紧跟 # 标题 → 拆成独立行 + 降为 ### 
#       2) 独立行开头的 # 标题 → 降为 ###
#       3) 空标题 "##### " → 删除
# 关键：只匹配单个 # 开头（^# 紧跟空格），不碰 ## 和 ###
#       加长度限制：标题内容≤30字才降级，避免长段落被误判
TEXT_BODY=$(echo "$TEXT_BODY" | python3 -c "
import sys, re
text = sys.stdin.read()
# 段落末尾 # 标题 拆行：xxx# 标题 → xxx\n\n### 标题
# 排除图注（含 | 或 年份），排除 ## 和 ###（只处理单个#），标题内容≤30字
def demote_inline(m):
    prefix = m.group(1)
    title = m.group(2)
    if len(title) > 25: return m.group(0)  # 太长不是标题
    return prefix + '\n\n### ' + title
text = re.sub(r'([。！？\n])#(?!#)(?!.*\|)(?!.*[0-9]{4}年)\s+(.+?)(?=\n|$)', demote_inline, text)
# 行首单 # 标题 降级：^# 标题 → ^### 标题（只匹配单个#，不碰##和###）
# 排除图注（含 | 或 年份），标题内容≤25字
def demote_line_start(m):
    title = m.group(1)
    if len(title) > 25: return m.group(0)  # 太长不是标题
    return '### ' + title
text = re.sub(r'^#(?!#)(?!.*\|)(?!.*[0-9]{4}年)\s+(.+?)$', demote_line_start, text, flags=re.MULTILINE)
# 行首 #### / ##### 降级为 ###（微信 H4-H6 都是章节小标题）
text = re.sub(r'^#{4,6}\s+(\S)', r'### \1', text, flags=re.MULTILINE)
# 清理标题行内的 HTML span 标签和加粗标记（标题不需要颜色和加粗）
text = re.sub(r'^(#{1,6}\s+)(<span[^>]*>)(\*{0,2})(.*?)(\*{0,2})(</span>)', lambda m: m.group(1) + m.group(4), text, flags=re.MULTILINE)
# 清理标题行内残留的 ** 加粗
text = re.sub(r'^(#{1,6}\s+.*)\*\*(.*?)\*\*', lambda m: m.group(1) + m.group(2), text, flags=re.MULTILINE)
# 非章节标题的行（作者/编辑/责编署名行）去掉 ### 前缀
text = re.sub(r'^###\s+(作者|编辑|责编|责任编)[：:]', r'\1：', text, flags=re.MULTILINE)
# 灰色文字图注处理：去掉灰色span包裹
text = re.sub(r'<span\s+style=[\x27\x22]color:rgb\(1[0-9]{2},\s*1[0-9]{2},\s*1[0-9]{2}\)[\x27\x22]>(.*?)</span>', r'\1', text, flags=re.DOTALL)
# 清理标题行内残留的彩色span包裹
text = re.sub(r'^(#{1,6}\s+)<span\s+style=[\x27\x22]color:[^>]*[\x27\x22]>(\*{0,2})(.*?)(\*{0,2})</span>', r'\1\3', text, flags=re.MULTILINE)
# 删除空标题（##### 后面无内容）
text = re.sub(r'^#{1,6}\s*$', '', text, flags=re.MULTILINE)
print(text)
")
IMG_COUNT=$(echo "$CONTENT" | jq '.images | length' 2>/dev/null)

echo "   📝 ${#TEXT_BODY} 字 | 🖼️ ${IMG_COUNT} 张图"

if [ "$IMG_COUNT" -eq 0 ]; then
  echo "   ⚠️ 未检测到图片"
fi

# ── 5. 确定图片文件名（静默）──

# 生成文章短标题（用于图片文件夹名），用 python3 确保 UTF-8 安全
# 用临时 .py 文件执行，避免 python3 -c 在不同 bash 环境下的转义差异
PY_TITLE_SCRIPT=$(mktemp /tmp/clip-title-XXXXXX.py)
cat > "$PY_TITLE_SCRIPT" << 'PYTHON_EOF'
import sys
import re

t = sys.argv[1] if len(sys.argv) > 1 else ""
# 去掉副标题
for sep in ['—', '｜']:
    if sep in t:
        t = t[:t.index(sep)]
# 先去原始空格和特殊字符（文件系统安全）
t = t.replace(' ', '')
for c in '/\:*?"<>|':
    t = t.replace(c, '')
for c in '\u201c\u201d\u2018\u2019\u300a\u300b\u300c\u300d\u300e\u300f\u3010\u3011\xab\xbb\u2026\u2014\uff5e\xb7':
    t = t.replace(c, '')

# 中文排版空格：在 CJK 字符与英文/数字之间插入空格
# 这样 AI 生成笔记时无论是否加空格，路径都能匹配
def insert_cjk_spacing(s):
    result = []
    for ch in s:
        if result:
            prev = result[-1]
            prev_cjk = '\u4e00' <= prev <= '\u9fff' or prev in '，。！？、：；\u201c\u201d\u2018\u2019（）【】《》'
            curr_cjk = '\u4e00' <= ch <= '\u9fff' or ch in '，。！？、：；\u201c\u201d\u2018\u2019（）【】《》'
            curr_ascii_alnum = ch.isascii() and (ch.isalpha() or ch.isdigit())
            prev_ascii_alnum = prev.isascii() and (prev.isalpha() or prev.isdigit())
            # CJK后面紧跟ASCII字母或数字：加空格
            if prev_cjk and curr_ascii_alnum:
                result.append(' ')
            # ASCII字母或数字后面紧跟CJK：加空格
            elif prev_ascii_alnum and curr_cjk:
                result.append(' ')
        result.append(ch)
    return ''.join(result).strip()

t = insert_cjk_spacing(t)[:30]
print(t)
PYTHON_EOF
SHORT_TITLE=$(python3 "$PY_TITLE_SCRIPT" "$TITLE" 2>/tmp/clip-title-err.log)
rm -f "$PY_TITLE_SCRIPT"
if [ -z "$SHORT_TITLE" ]; then
  SHORT_TITLE="文章"
fi
IMG_DIR="${IMG_BASE_DIR}/${SHORT_TITLE}"
mkdir -p "$IMG_DIR"

# 重跑时清理旧图片（避免重名加 _2 后缀和旧文件残留）
if [ "$(ls -A "$IMG_DIR" 2>/dev/null)" ]; then
  rm -rf "${IMG_DIR:?}"/* 2>/dev/null || true
fi

# 相对路径（直接由脚本输出，不交给 AI 计算）
REL_IMG_DIR="04-assets/images/${SHORT_TITLE}"

# 从 imageMap 生成文件名（处理重名），带文章前缀便于 Obsidian 搜索定位
# 先用 jq 生成基础文件名，再用 Python 加中文排版空格
RAW_FILENAMES_JSON=$(echo "$CONTENT" | jq -r --arg prefix "$SHORT_TITLE" '
  .images | to_entries | map(
    .value as $img |
    (if ($img.src | contains("?")) then
      ($img.src | split("?")[1] | split("&") | map(select(startswith("wx_fmt="))) | first // "" | split("=") | .[1])
    else
      ""
    end) as $raw_fmt |
    ($raw_fmt | if . and (. != "") and (. != "other") then . else "jpg" end) as $ext |
    if $img.caption and ($img.caption | length > 0) and ($img.caption != "图片") then
      ("[" + $prefix + "] " + ($img.caption | gsub("[\\\\/:*?\"|\\n\\r]"; "") | gsub("[<>]"; "") | .[0:10])) + "." + $ext
    else
      "[" + $prefix + "] 图片上下文_" + (.key | tostring) + "." + $ext
    end
  )')

# 用 Python 给文件名加中文排版空格（CJK与ASCII之间），使文件名与AI输出一致
FN_SPACING_SCRIPT=$(mktemp /tmp/clip-fnspacing-XXXXXX.py)
cat > "$FN_SPACING_SCRIPT" << 'PYEOF'
import sys, json

def insert_cj(s):
    for d in '\u201c\u201d\u2018\u2019\u300a\u300b\u300c\u300d\u300e\u300f\u3010\u3011\xab\xbb\x22\x27':
        s = s.replace(d, "")
    r = []
    for ch in s:
        if r:
            p = r[-1]
            pc = '\u4e00' <= p <= '\u9fff' or p in '，。！？、：；\u201c\u201d\u2018\u2019（）【】《》'
            cc = '\u4e00' <= ch <= '\u9fff' or ch in '，。！？、：；\u201c\u201d\u2018\u2019（）【】《》'
            ca = ch.isascii() and (ch.isalpha() or ch.isdigit())
            pa = p.isascii() and (p.isalpha() or p.isdigit())
            if pc and ca: r.append(" ")
            elif pa and cc: r.append(" ")
        r.append(ch)
    return "".join(r).strip()

names = json.loads(sys.argv[1])
print(json.dumps([insert_cj(n) for n in names], ensure_ascii=False))
PYEOF

FILENAMES_JSON=$(python3 "$FN_SPACING_SCRIPT" "$RAW_FILENAMES_JSON" 2>/dev/null)
rm -f "$FN_SPACING_SCRIPT"

# 处理重名：检查已有文件
FILEPATHS_JSON="[]"
for i in $(seq 0 $((IMG_COUNT - 1))); do
  FN=$(echo "$FILENAMES_JSON" | jq -r ".[$i]")
  FP="${IMG_DIR}/${FN}"
  COUNTER=2
  while [ -f "$FP" ]; do
    BASE=$(echo "$FN" | sed 's/\.[^.]*$//')
    EXT="${FN##*.}"
    FN="${BASE}_${COUNTER}.${EXT}"
    FP="${IMG_DIR}/${FN}"
    COUNTER=$((COUNTER + 1))
  done
  FILEPATHS_JSON=$(echo "$FILEPATHS_JSON" | jq --arg fn "$FN" --arg fp "$FP" '. + [{filename: $fn, filepath: $fp}]')
done

# 文件名列表不再逐行打印（太吵），有失败时在下载阶段展示

# ── 6. 下载图片（静默循环，汇总报告）──
echo "   ⬇️ 下载图片中..."

# 预创建完整 images 数组（与 {{IMG_N}} 一一对应，保持索引一致）
ALL_IMGS="[]"
for i in $(seq 0 $((IMG_COUNT - 1))); do
  IMG_SRC=$(echo "$CONTENT" | jq -r ".images[$i].src" 2>/dev/null)
  IMG_CAPTION=$(echo "$CONTENT" | jq -r ".images[$i].caption // empty" 2>/dev/null)
  ALL_IMGS=$(echo "$ALL_IMGS" | jq \
    --arg idx "$i" --arg src "$IMG_SRC" --arg cap "$IMG_CAPTION" \
    '. + [{idx: ($idx|tonumber), src: $src, caption: $cap, filepath: "", filename: "", status: "pending"}]')
done

FAILED_IMGS="[]"
FAILED_DETAILS=""  # 用于失败详情展示

for i in $(seq 0 $((IMG_COUNT - 1))); do
  IMG_SRC=$(echo "$CONTENT" | jq -r ".images[$i].src" 2>/dev/null)
  IMG_CAPTION=$(echo "$CONTENT" | jq -r ".images[$i].caption // empty" 2>/dev/null)
  FILENAME=$(echo "$FILEPATHS_JSON" | jq -r ".[$i].filename" 2>/dev/null)
  FILEPATH=$(echo "$FILEPATHS_JSON" | jq -r ".[$i].filepath" 2>/dev/null)

  # 防御性检查：filepath 不能为空
  if [ -z "$FILEPATH" ] || [ -z "$FILENAME" ]; then
    FAILED_DETAILS="${FAILED_DETAILS}      ❌ [$((i+1))] 文件路径缺失\n"
    ALL_IMGS=$(echo "$ALL_IMGS" | jq \
      --argjson idx "$i" --arg src "$IMG_SRC" --arg cap "$IMG_CAPTION" \
      'map(if .idx == $idx then . + {status: "failed"} else . end)')
    FAILED_IMGS=$(echo "$FAILED_IMGS" | jq --arg idx "$i" --arg src "$IMG_SRC" --arg cap "$IMG_CAPTION" \
      '. + [{idx: ($idx|tonumber), src: $src, caption: $cap}]')
    continue
  fi

  # curl 下载
  HTTP_CODE=$(curl -s -o "$FILEPATH" -w "%{http_code}" "$IMG_SRC" \
    -H "Referer: https://mp.weixin.qq.com" \
    --max-time 15 --retry 1 --retry-delay 2 --retry-all-errors 2>/dev/null || echo "000")

  FILE_SIZE=$(stat -f%z "$FILEPATH" 2>/dev/null || echo 0)

  if [ "$FILE_SIZE" -gt 500 ]; then
    # 更新 ALL_IMGS 中该位置为成功
    ALL_IMGS=$(echo "$ALL_IMGS" | jq \
      --argjson idx "$i" --arg fp "$FILEPATH" --arg fn "$FILENAME" --arg cap "$IMG_CAPTION" \
      'map(if .idx == $idx then . + {filepath: $fp, filename: $fn, caption: $cap, status: "ok"} else . end)')
  else
    rm -f "$FILEPATH"

    # fetch 兜底（带超时）
    BASE64_DATA=$(safe_eval "$TAB_ID" "
    (async function(){
      var imgs = document.querySelectorAll('#js_content img[data-src], #js_content img[src]');
      var img = imgs[$i];
      if (!img) return JSON.stringify({error:'img not found'});
      try {
        var resp = await fetch(img.currentSrc || img.dataset.src || img.src);
        if (!resp.ok) return JSON.stringify({error: resp.status});
        var blob = await resp.blob();
        return new Promise(function(resolve) {
          var reader = new FileReader();
          reader.onload = function() { resolve({base64: reader.result.split(',')[1], type: blob.type}); };
          reader.readAsDataURL(blob);
        });
      } catch(e) { return JSON.stringify({error: e.message}); }
    })()" 30)

    B64_STR=$(echo "$BASE64_DATA" | jq -r '.base64 // empty' 2>/dev/null)
    B64_ERR=$(echo "$BASE64_DATA" | jq -r '.error // empty' 2>/dev/null)

    if [ -n "$B64_STR" ] && [ ${#B64_STR} -gt 100 ]; then
      echo "$B64_STR" | base64 -d > "$FILEPATH"
      FILE_SIZE=$(stat -f%z "$FILEPATH" 2>/dev/null || echo 0)
      if [ "$FILE_SIZE" -gt 500 ]; then
        ALL_IMGS=$(echo "$ALL_IMGS" | jq \
          --argjson idx "$i" --arg fp "$FILEPATH" --arg fn "$FILENAME" --arg cap "$IMG_CAPTION" \
          'map(if .idx == $idx then . + {filepath: $fp, filename: $fn, caption: $cap, status: "ok"} else . end)')
      else
        FAILED_DETAILS="${FAILED_DETAILS}      ❌ [$((i+1))] ${FILENAME} (fetch 空文件)\n"
        rm -f "$FILEPATH"
        ALL_IMGS=$(echo "$ALL_IMGS" | jq \
          --argjson idx "$i" --arg src "$IMG_SRC" --arg cap "$IMG_CAPTION" \
          'map(if .idx == $idx then . + {status: "failed"} else . end)')
        FAILED_IMGS=$(echo "$FAILED_IMGS" | jq --arg idx "$i" --arg src "$IMG_SRC" --arg cap "$IMG_CAPTION" \
          '. + [{idx: ($idx|tonumber), src: $src, caption: $cap}]')
      fi
    else
      FAILED_DETAILS="${FAILED_DETAILS}      ❌ [$((i+1))] ${FILENAME} (curl+fetch 均失败)\n"
      ALL_IMGS=$(echo "$ALL_IMGS" | jq \
        --argjson idx "$i" --arg src "$IMG_SRC" --arg cap "$IMG_CAPTION" \
        'map(if .idx == $idx then . + {status: "failed"} else . end)')
      FAILED_IMGS=$(echo "$FAILED_IMGS" | jq --arg idx "$i" --arg src "$IMG_SRC" --arg cap "$IMG_CAPTION" \
        '. + [{idx: ($idx|tonumber), src: $src, caption: $cap}]')
    fi
  fi
done

DOWNLOADED_COUNT=$(echo "$ALL_IMGS" | jq '[.[] | select(.status == "ok")] | length' 2>/dev/null)
FAILED_COUNT=$(echo "$FAILED_IMGS" | jq 'length' 2>/dev/null)

# ── 汇总输出 ──
if [ "$FAILED_COUNT" -eq 0 ]; then
  echo "   ✅ 图片 ${DOWNLOADED_COUNT}/${IMG_COUNT} 全部成功"
else
  echo "   ⚠️ 图片 ${DOWNLOADED_COUNT}/${IMG_COUNT} 成功, ${FAILED_COUNT} 张失败:"
  echo -e "$FAILED_DETAILS"
fi

# ── 7. 关闭标签页（静默）──
curl -s --max-time 5 "http://localhost:${CDP_PORT}/close?target=${TAB_ID}" > /dev/null 2>&1 || true

# ── 8. 输出 JSON（用 Python 处理大数据量，避免 jq 命令行参数溢出）──
# 将所有数据写入临时文件让 Python 读取（TEXT_BODY 可能超过 26000 字符）
TMP_JSON_DIR="${VAULT_DIR}/.tmp-clip"
mkdir -p "$TMP_JSON_DIR"

printf '%s' "$TEXT_BODY" > "${TMP_JSON_DIR}/text_body.txt"
printf '%s' "$ALL_IMGS" > "${TMP_JSON_DIR}/all_imgs.json"
printf '%s' "$FAILED_IMGS" > "${TMP_JSON_DIR}/failed.json"
printf '%s' "$TITLE" > "${TMP_JSON_DIR}/title.txt"
printf '%s' "$AUTHOR" > "${TMP_JSON_DIR}/author.txt"
printf '%s' "$ACCOUNT" > "${TMP_JSON_DIR}/account.txt"
printf '%s' "$ACCOUNT_URL" > "${TMP_JSON_DIR}/account_url.txt"
printf '%s' "$PUB_DATE" > "${TMP_JSON_DIR}/publish_date.txt"
printf '%s' "$URL" > "${TMP_JSON_DIR}/source.txt"
printf '%s' "$IMG_DIR" > "${TMP_JSON_DIR}/img_dir.txt"
printf '%s' "$REL_IMG_DIR" > "${TMP_JSON_DIR}/rel_dir.txt"

OUTPUT_JSON=$(python3 -c "
import json, os

base = '${TMP_JSON_DIR}'
def readf(name):
    with open(os.path.join(base, name), 'r') as f:
        return f.read()

text_body = readf('text_body.txt')
all_images = json.loads(readf('all_imgs.json'))
failed = json.loads(readf('failed.json'))

ok_images = [
    {'idx': i['idx'], 'filepath': i.get('filepath', ''), 'filename': i.get('filename', ''),
     'caption': i.get('caption', ''),
     'markdown': '![[%s/%s]]' % (readf('rel_dir.txt'), i.get('filename', ''))}
    for i in all_images if i.get('status') == 'ok'
]
all_out = [
    {'idx': i['idx'], 'filepath': i.get('filepath', ''), 'filename': i.get('filename', ''),
     'caption': i.get('caption', ''), 'status': i.get('status', ''),
     'markdown': ('![[%s/%s]]' % (readf('rel_dir.txt'), i.get('filename', ''))) if i.get('status') == 'ok' else ''}
    for i in all_images
]

result = {
    'title': readf('title.txt'),
    'author': readf('author.txt'),
    'account': readf('account.txt'),
    'accountUrl': readf('account_url.txt'),
    'publishDate': readf('publish_date.txt'),
    'source': readf('source.txt'),
    'text': text_body,
    'imgDir': readf('img_dir.txt'),
    'relDir': readf('rel_dir.txt'),
    'images': ok_images,
    'allImages': all_out,
    'failed': failed,
    'downloadedCount': len(ok_images),
    'failedCount': len(failed)
}
print(json.dumps(result, ensure_ascii=False))
")

# 临时目录清理（在 python 外部执行，确保即使 print 成功但 rmtree 异常也能清理）
rm -rf "${TMP_JSON_DIR}" 2>/dev/null || true

# 输出到 stdout
echo "   📁 → 02-Knowledge/好文章/${TITLE}"
echo "   🖼️ → ${REL_IMG_DIR}/ （${DOWNLOADED_COUNT:-0}张）"
echo ""
echo "========== OUTPUT_JSON_START =========="
echo "$OUTPUT_JSON"
echo "========== OUTPUT_JSON_END =========="
echo "✅ 完成"
