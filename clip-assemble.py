#!/usr/bin/env python3
"""clip-assemble.py — 从 JSON 组装 Obsidian Markdown 笔记

用法: python3 clip-assemble.py <vault_dir>
输入: stdin（clip-fetch.sh 输出的 JSON，在 OUTPUT_JSON_START/END 标记之间）
输出:
  - 写入 <vault_dir>/02-Knowledge/好文章/<author> <title>.md
  - stdout 输出状态信息（文件路径、图片统计等，供 AI 读取）
"""

import sys
import os
import json
import re
from datetime import datetime


# ── 输入处理 ──

def read_json_from_stdin():
    """从 stdin 提取 OUTPUT_JSON_START/END 之间的 JSON"""
    raw = sys.stdin.read()

    # 提取标记之间的内容
    match = re.search(
        r'========== OUTPUT_JSON_START ==========\s*(.*?)\s*========== OUTPUT_JSON_END ==========',
        raw, re.DOTALL
    )
    if not match:
        return None, {'error': '未找到 JSON 输出标记', 'errorType': 'parse_error'}

    json_str = match.group(1).strip()
    try:
        data = json.loads(json_str)
    except json.JSONDecodeError as e:
        return None, {'error': 'JSON 解析失败: {}'.format(str(e)), 'errorType': 'parse_error'}

    # 检查脚本是否报错
    if 'error' in data:
        return None, data

    return data, None


# ── 图片占位符替换 ──

def replace_image_placeholders_with_validation(text, all_images):
    """图片替换（信任 JS 端图注判断结果）
    
    图注格式：小字体、淡色、紧贴图片
    - 有 caption: ![[path]]\n\n<small style="color:gray">caption</small>\n
    - 无 caption: ![[path]]
    - 失败: [图片加载失败]
    
    JS 端已通过位置优先+打分模型判断图注，Python 端不再二次判断。
    额外处理：JS 端 htmlToMarkdown 会把图注文字输出到正文（紧跟占位符后），
    如果 caption 有效，需要把正文里重复的 caption 文字删掉，避免出现两次。
    """
    result = text
    for img in all_images:
        idx = img.get('idx', -1)
        placeholder = '{{' + 'IMG_{}'.format(idx) + '}}'

        if placeholder not in result:
            continue

        if img.get('status') == 'ok':
            md_link = img.get('markdown', '')
            caption = img.get('caption', '').strip()
            if caption:
                replacement = '{}\n\n<small style="color:gray">{}</small>\n'.format(md_link, caption)
                # 删除正文中紧跟占位符后的重复 caption 文字
                # 匹配模式：占位符后面紧跟 caption 文字（可能跨0~2行）
                escaped_caption = re.escape(caption)
                result = re.sub(
                    r'\{\{IMG_' + str(idx) + r'\}\}[ \t]*\n{0,2}[ \t]*' + escaped_caption,
                    replacement,
                    result,
                    flags=re.MULTILINE
                )
                # 如果上面的替换没命中（caption 可能已经被替换了），做普通替换
                if placeholder in result:
                    result = result.replace(placeholder, replacement)
            else:
                # 无 caption → 只保留图片
                result = result.replace(placeholder, md_link)
        else:
            replacement = '[图片加载失败]'
            result = result.replace(placeholder, replacement)

    return result


# ── Frontmatter 生成 ──

def build_frontmatter(data):
    """
    生成 YAML frontmatter

    机械字段（脚本填充）：title, source, author, published, created, status
    理解字段（留空，AI 后填）：tags, summary
    
    author 格式：个人作者名 [[公众号名]]
      - 个人作者名 = 原创后面那个人
      - [[公众号名]] = Obsidian 可点击跳转本地同名笔记
      - 如果个人作者和公众号同名，只显示一个名字
    """
    today = datetime.now().strftime('%Y-%m-%d')

    title = data.get('title', 'Untitled')
    source = data.get('source', '')
    author = data.get('author', 'unknown')
    account = data.get('account', '') or author
    published = data.get('publishDate', 'unknown')

    # 手动拼 YAML，避免 pyyaml 依赖
    def yaml_escape(s):
        if not s:
            return '""'
        if any(c in s for c in [':', '"', "'", '#', '&', '*', '?', '|', '-', '<', '>', '=', '!', '%', '@', '`', ',', '{', '}', '[', ']']):
            return '"{}"'.format(s.replace('"', '\\"'))
        return s

    # 作者名 + [[公众号名]]（Obsidian 内部链接，始终保留以支持跳转）
    author_line = '{} [[{}]]'.format(yaml_escape(author), yaml_escape(account))

    lines = [
        '---',
        'title: "[{}]({})"'.format(title.replace('"', '\\"'), source),
        'author: {}'.format(author_line),
        'published: {}'.format(yaml_escape(published)),
        'created: {}'.format(today),
        'tags:',
        'summary:',
        '---',
        '',
    ]

    return '\n'.join(lines)


# ── 文件名生成 ──

def safe_filename(s, max_len=30):
    """生成安全的文件名：去特殊字符，限制长度"""
    # 去除文件系统不安全的字符
    s = re.sub(r'[/\\:*?"<>|#^[\]{}]', '', s)
    # 去除连续空格
    s = re.sub(r'\s+', ' ', s).strip()
    # 截断
    if len(s) > max_len:
        s = s[:max_len].rstrip()
    return s


def build_filepath(data, vault_dir):
    """
    生成笔记文件路径

    格式: <vault_dir>/02-Knowledge/好文章/<account> <title>.md
    account 优先使用公众号名，fallback 到 author
    """
    account = data.get('account', '') or data.get('author', 'unknown')
    author = safe_filename(data.get('author', 'unknown'), max_len=15)
    title = safe_filename(data.get('title', 'Untitled'), max_len=30)
    # 文件夹和文件名用公众号名（而非个人作者）
    filename = '{} {}.md'.format(safe_filename(account, max_len=15), title)
    dir_path = os.path.join(vault_dir, '02-Knowledge', '好文章')
    os.makedirs(dir_path, exist_ok=True)
    return os.path.join(dir_path, filename)


# ── 完整笔记组装 ──

def shrink_references(text):
    """将参考资料区域用 <small> 包裹，使其在 Obsidian 中以较小字号显示
    
    策略1：找到「参考资料」标题行，从该行开始到文件末尾全部包裹在 <small> 中。
    策略2：如果没有「参考资料」标题，找第一个 [N] 开头的参考文献条目行作为起点。
    参考资料区域后面不会再有正文，所以直接包到末尾即可。
    """
    import re as _re
    # 清理不可见字符（\xa0 non-breaking space 等），避免干扰正则
    text = text.replace('\xa0', ' ')
    lines = text.split('\n')
    result_lines = []
    ref_start = -1
    
    for i, line in enumerate(lines):
        # 策略1：检测参考资料起始行（兼容 ### 前缀和有无冒号）
        if _re.match(r'^#{0,6}\s*参考资料[：:]?\s*$', line):
            ref_start = i
            break
        # 策略2：检测 [N] 开头的参考文献条目（需要至少2个连续条目才算）
        # 注意：[N] 可能被 <span style="color:..."> 包裹（可能嵌套多层），需要去掉所有 span 标签后再检测
        stripped = line.strip()
        stripped_clean = _re.sub(r'<span\s+style=[^>]*>', '', stripped)
        if _re.match(r'^\[\d+\][\s\xa0]*\S', stripped_clean) and ref_start == -1:
            # 向后检查是否有更多条目
            count = 0
            for j in range(i, min(i + 30, len(lines))):
                stripped_j = lines[j].strip()
                stripped_j_clean = _re.sub(r'<span\s+style=[^>]*>', '', stripped_j)
                if _re.match(r'^\[\d+\][\s\xa0]*\S', stripped_j_clean):
                    count += 1
            if count >= 2:
                ref_start = i
                break
    
    if ref_start >= 0:
        # 参考资料 + 后续全部内容用 <small> 包裹
        result_lines = lines[:ref_start]
        ref_lines = lines[ref_start:]
        # 把 ### 参考资料 降为普通文本（<small> 内不需要标题渲染）
        if ref_lines and _re.match(r'^#{1,6}\s*参考资', ref_lines[0]):
            ref_lines[0] = _re.sub(r'^#{1,6}\s*', '', ref_lines[0])
        # 去掉末尾空行
        while ref_lines and ref_lines[-1].strip() == '':
            ref_lines.pop()
        result_lines.append('<small>')
        result_lines.extend(ref_lines)
        result_lines.append('</small>')
    else:
        result_lines = lines
    
    return '\n'.join(result_lines)


def build_note(data):
    """
    组装完整的 .md 笔记

    结构：
    ---
    frontmatter（tags/summary 留空）
    ---

    ## ==关键要点==

    <!-- FILL:key-points -->

    ## ==我的思考==

    <!-- FILL:my-thoughts -->

    ## ==发芽==

    <!-- FILL:sprout -->

    ## ==文章标题==

    （已替换图片占位符的正文）
    """
    frontmatter = build_frontmatter(data)

    # 替换图片占位符（带 caption 验证）
    markdown_body = replace_image_placeholders_with_validation(
        data.get('text', ''),
        data.get('allImages', [])
    )
    
    # 忠于原文：<span style="color:..."> 原样保留，不做 span→font 转换
    # Obsidian 阅读模式支持 <span style> HTML 渲染
    # 只做换行符统一
    markdown_body = markdown_body.replace('\r\n', '\n').replace('\r', '\n')
    
    # 微调1：灰色 span 图注 → <small style="color:gray">caption</small>
    # 微信图注颜色通常是 rgb(138,137,137) 或 rgb(136,136,136) 等灰色
    # 只转灰色图注，其他颜色 span 保持原样
    def is_gray_color(color_str):
        """判断颜色是否为灰色（R≈G≈B 且值在 100-180 之间）"""
        color_clean = color_str.strip().replace(' ', '')
        rgb_match = re.match(r'rgb\((\d+),(\d+),(\d+)\)', color_clean)
        if rgb_match:
            r, g, b = int(rgb_match.group(1)), int(rgb_match.group(2)), int(rgb_match.group(3))
            return abs(r-g) <= 20 and abs(g-b) <= 20 and 100 <= r <= 180
        return False

    # 两步走：先转灰色span开标签，再配对替换闭标签
    # Step1: <span style="color:rgb(138,137,137)"> → <small style="color:gray">
    def gray_span_to_small(match):
        style_content = match.group(1)
        color_match = re.search(r'color:\s*([^;\'"]+)', style_content)
        if color_match and is_gray_color(color_match.group(1)):
            return '<small style="color:gray">'
        return match.group(0)  # 非灰色 span 保持原样
    markdown_body = re.sub(r'<span\s+style=[\'"]([^\'"]*?)[\'"]>', gray_span_to_small, markdown_body)
    # Step2: 配对替换 </span> → </small>（只替换紧跟 <small style="color:gray"> 后的 </span>）
    markdown_body = re.sub(
        r'(<small style="color:gray">)((?:(?!<span\s).)*?)(</span>)',
        r'\1\2</small>',
        markdown_body
    )

    # 微调2：换行控制
    # <small>图注</small> 后面保持1个空行
    markdown_body = re.sub(r'(</small>)\n{2,}', r'\1\n\n', markdown_body)
    # 全局3+空行压2
    markdown_body = re.sub(r'\n{3,}', '\n\n', markdown_body)

    # 参考资料区域字体缩小
    markdown_body = shrink_references(markdown_body)

    note_parts = [
        frontmatter,
        '## ==关键要点==',
        '',
        '<!-- FILL:key-points -->',
        '',
        '## ==我的思考==',
        '',
        '<!-- FILL:my-thoughts -->',
        '',
        '## ==发芽==',
        '',
        '<!-- FILL:sprout -->',
        '',
        '## ' + data.get('title', '完整原文'),
        '',
        markdown_body,
        '',
    ]

    return '\n'.join(note_parts)


# ── 输出状态信息 ──

def build_status_output(filepath, data):
    """生成 stdout 状态信息，供 AI 读取"""
    rel_path = filepath.split('obsidian-system/')[-1] if 'obsidian-system/' in filepath else filepath
    ok_count = data.get('downloadedCount', 0)
    fail_count = data.get('failedCount', 0)
    rel_img_dir = data.get('relDir', '')

    lines = [
        '✅ 笔记已生成（必须继续执行第三步：填充 tags / summary / 关键要点 / 我的思考 / 发芽）',
        '',
        '📝 文件路径：{}'.format(filepath),
        '文件：[[{}]]'.format(rel_path),
        '图片：{} (成功 {} 张，失败 {} 张)'.format(rel_img_dir, ok_count, fail_count),
    ]

    # 如果有失败图片，列出 URL
    failed = data.get('failed', [])
    if failed:
        lines.append('')
        lines.append('失败图片：')
        for f in failed:
            src = f.get('src', '')
            if src:
                lines.append('  - {}'.format(src))

    return '\n'.join(lines)


# ── 主流程 ──

def main():
    if len(sys.argv) < 2:
        print('用法: python3 clip-assemble.py <vault_dir>', file=sys.stderr)
        sys.exit(1)

    vault_dir = sys.argv[1]

    # 1. 从 stdin 读取 JSON
    data, error = read_json_from_stdin()

    if error:
        # 透传错误信息到 stderr
        err_msg = error.get('error', '未知错误')
        err_type = error.get('errorType', 'unknown')
        print('❌ 脚本错误: {}'.format(err_msg), file=sys.stderr)
        # 同时输出 JSON 标记格式，让 AI 能识别
        print('')
        print('========== OUTPUT_JSON_START ==========')
        print(json.dumps(error, ensure_ascii=False))
        print('========== OUTPUT_JSON_END ==========')
        sys.exit(1)

    # 2. 检查文件是否已存在
    filepath = build_filepath(data, vault_dir)
    if os.path.exists(filepath):
        # 输出提示，让 AI 处理覆盖确认
        rel_path = filepath.split('obsidian-system/')[-1] if 'obsidian-system/' in filepath else filepath
        print('⚠️ 文件已存在: {}'.format(rel_path), file=sys.stderr)
        print('FILE_EXISTS:{}'.format(filepath))
        # 不覆盖，退出让 AI 询问用户
        sys.exit(2)

    # 3. 组装笔记
    note_content = build_note(data)

    # 3.5 兜底清洗
    lines = note_content.split('\n')
    # 用计数器追踪参考资料 <small> 区域深度
    # 只响应纯 <small> 标签（参考资料区域），不受图注 <small style="color:gray"> 的 </small> 干扰
    small_depth = 0
    for i, line in enumerate(lines):
        # tags 中文逗号 → 英文逗号
        if line.startswith('tags:'):
            lines[i] = line.replace('，', ', ')
            lines[i] = re.sub(r',\s+,', ',', lines[i])
            lines[i] = re.sub(r'\[\s+', '[', lines[i])
            lines[i] = re.sub(r'\s+\]', ']', lines[i])
        # 只检测纯 <small>（参考资料区域开标签），不检测 <small style=...>（图注）
        if line.strip() == '<small>': small_depth += 1
        if line.strip() == '</small>' and small_depth > 0: small_depth -= 1
        if small_depth > 0:
            if '**' in lines[i]:
                lines[i] = lines[i].replace('**', '')
            # 去掉彩色 span 标签（参考资料不需要颜色标注，可能嵌套多层）
            lines[i] = re.sub(r'<span\s+style=[\'"][^\'"]*[\'"]>', '', lines[i])
            lines[i] = lines[i].replace('</span>', '')

    # 3.6 删除与图注重复的 ### 标题（图注 <small>caption</small> 后紧跟 ### 同内容 → 删除 ### 行）
    # 同时：超过25字的 ### 行恢复为普通文本（长段落不应是标题）
    i = 0
    while i < len(lines):
        # 图注格式：<small style="color:gray">caption</small>
        line_stripped = lines[i].strip()
        if line_stripped.startswith('<small') and line_stripped.endswith('</small>'):
            # 提取 caption 文字
            m = re.match(r'<small[^>]*>(.*?)</small>', line_stripped)
            if m:
                caption_text = m.group(1).strip()
                # 跳过空行
                j = i + 1
                while j < len(lines) and lines[j].strip() == '':
                    j += 1
                if j < len(lines) and lines[j].startswith('### '):
                    h3_text = lines[j][4:].strip()
                    if caption_text == h3_text:
                        lines[j] = ''  # 删除重复的 ### 行
        # 超过25字的 ### 行恢复为普通文本（非章节标题）
        # 豁免：数字编号开头（如 "01. xxx"、"3、"）是章节标题，不降级
        if lines[i].startswith('### '):
            h3_content = lines[i][4:].strip()
            if len(h3_content) > 25:
                if not re.match(r'^\d+[\.\、\s]\s*', h3_content):
                    lines[i] = h3_content  # 去掉 ### 前缀
        i += 1
    note_content = '\n'.join(lines)

    # 3.7 清理图片占位符前的多余空行
    # 问题：微信图片前常有 <br>，转换后产生 "\n\n  \n\n![[...]]"（3+空行）
    # 修复：图片嵌入行前面只保留1个空行（1个\n\n）
    lines = note_content.split('\n')
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith('![[') or stripped.startswith('[图片'):
            # 向前回溯，把图片上方连续的空行/仅空格行压缩为1个空行
            j = i - 1
            first_blank = -1
            while j >= 0 and (lines[j].strip() == ''):
                if first_blank == -1:
                    first_blank = j  # 保留最靠近图片的那行空行
                else:
                    lines[j] = '\x00DELETE'  # 标记为删除
                j -= 1
            # 如果图片前面没有内容行（即文章开头），不需要保留空行
            if j < 0:
                if first_blank > -1:
                    lines[first_blank] = '\x00DELETE'
    lines = [l for l in lines if l != '\x00DELETE']
    note_content = '\n'.join(lines)

    # 3.9 图片后紧跟的短文本自动转灰色小字（补充 JS 端漏识别的图注）
    # JS 端通过8条路径+打分模型识别图注，但有些图注因 DOM 结构特殊被漏判
    # 这里用「位置优先」原则：紧贴图片的短文本，大概率是图注
    # 规则：![[...]] 后 0~1 个空行内的文本行，长度 ≤50 且非章节标题，用 <small> 包裹
    # 安全限制：只在正文区域（## 标题之后）处理，不影响 frontmatter
    lines = note_content.split('\n')
    in_body = False  # 是否已进入正文区域（frontmatter 之后）
    img_line_indices = []
    # 先收集所有图片行的索引
    for i, line in enumerate(lines):
        if line.startswith('## '):
            in_body = True
        if in_body and (line.strip().startswith('![[') or line.strip().startswith('[图片')):
            img_line_indices.append(i)

    for img_idx in img_line_indices:
        # 查找图片后 0~1 个空行内的文本行
        check_idx = img_idx + 1
        # 跳过1个空行
        if check_idx < len(lines) and lines[check_idx].strip() == '':
            check_idx += 1
        # 检查紧跟的文本行
        if check_idx < len(lines):
            candidate = lines[check_idx]
            stripped_c = candidate.strip()
            # 跳过条件：空行、已在 <small> 中、章节标题、图片行、引用条目
            if not stripped_c:
                continue
            if stripped_c.startswith('<small'):
                continue  # 已经是灰色小字，不重复包裹
            if stripped_c.startswith('#'):
                continue  # 章节标题
            if stripped_c.startswith('![[') or stripped_c.startswith('[图片'):
                continue  # 连续图片
            if re.match(r'^\[\d+\]', stripped_c):
                continue  # 引用条目
            # 长度限制：≤50字
            if len(stripped_c) > 50:
                continue
            # 排除特征：明显的正文标记
            if re.match(r'^(但是|然而|不过|因此|所以|于是|此外|同时|另外|至于|值得一提|值得注意|需要指出|事实上|实际上|举个例子|整体来看|总体来看|总的来看|简而言之|总而言之|换句话说|也就是说|由此可见|不难看出|不难发现|当|随着|通过|经过|据|根据)', stripped_c):
                continue
            # 排除特征：代词开头+>15字（叙述性正文信号）
            # 豁免："从A到B"并列结构是常见图注格式（如"从《A》到《B》的..."）
            if re.match(r'^(这|那|他|她|它|我|你|我们|他们|她们|从|在|到|把|被)', stripped_c) and len(stripped_c) > 15:
                # "从A到B"图注结构豁免：短文本+"从...到/至..."且不含动词复合词
                if stripped_c.startswith('从') and len(stripped_c) <= 35:
                    if re.search(r'(到|至)', stripped_c) and not re.search(r'(看到|感到|得到|想到|回到|走到|来到|找到|达到|遇到|拿到|起到|收到|碰到|转到|料到|办到|做到|买到|传到|递到)', stripped_c):
                        pass  # "从A到B"图注，不排除，继续处理
                    else:
                        continue
                else:
                    continue
            # 排除特征：已有 Markdown 格式（加粗、列表等）
            if stripped_c.startswith('**') or stripped_c.startswith('- ') or stripped_c.startswith('> '):
                continue
            # 安全检查：上一行是图片且当前行是短文本 → 转为灰色小字
            lines[check_idx] = '<small style="color:gray">{}</small>'.format(stripped_c)

    note_content = '\n'.join(lines)

    # 3.8 引用链接行间分隔：确保 [N] 引用条目之间有换行
    # 微信引用链接是单个 <p> 内用 <br> 分隔，JS 端 BR→"  \n"软换行
    # 但软换行经常被行内标记(*斜体*等)吞掉，导致 [1]xxx[2]yyy 粘合
    # 修复：在 [数字] 引用标号前强制换行（不管前面是什么）
    note_content = re.sub(r'(\S)\[(\d+)\]', r'\1\n[\2]', note_content)
    # 但不要破坏正文中的 [1] 内联引用（如 "Claude Code[1]"），只处理引用列表区域
    # 策略回滚：只处理连续的引用条目（前一行也是引用条目的情况）
    # 恢复：先撤销上面的全局替换，用更精准的策略
    note_content = re.sub(r'\n\[(\d+)\]', r'[\1]', note_content)  # 先撤销

    # 精准策略：引用列表中，紧跟在上一条引用后面的 [N] 前加换行
    # 模式：*URL*[N] 或 *URL*  \n[N] → *URL*\n[N]
    note_content = re.sub(r'(\*https?://[^*]+\*)\[(\d+)\]', r'\1\n[\2]', note_content)
    # 兜底：[N] 引用标号紧跟在另一个引用标号内容后（无空行分隔）时，加换行
    note_content = re.sub(r'(\*https?://[^*]+\*)(\s*)(\[[\d]+\])', r'\1\2\n\3', note_content)

    # 4. 写入文件（统一换行符为 LF，清除 JS 端残留的 \r）
    note_content = note_content.replace('\r\n', '\n').replace('\r', '\n')
    with open(filepath, 'w', encoding='utf-8', newline='\n') as f:
        f.write(note_content)

    # 5. 输出状态信息到 stdout
    status = build_status_output(filepath, data)
    print(status)


if __name__ == '__main__':
    main()
