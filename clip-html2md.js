// clip-html2md.js — HTML→Markdown conversion + image/caption extraction for WeChat articles
// Used by clip-fetch.sh via CDP /eval endpoint
// Extracted from clip-fetch.sh heredoc for maintainability

(function(){
  var el = document.querySelector("#js_content");
  if (!el) el = document.querySelector("article") || document.querySelector("main") || document.body;
  var clone = el.cloneNode(true);
  var imgs = Array.from(clone.querySelectorAll("img[data-src], img[src]"));
  var imageMap = [];
  var imgCounter = 0;
  imgs.forEach(function(img) {
    var rawSrc = img.dataset.src || img.src;
    if (!rawSrc || rawSrc.startsWith("data:")) return;
    // BUG-5修复：跳过 GIF（微信公众号文章里 GIF 几乎都是装饰/推广/分隔动画，不是正文配图）
    // 微信 CDN 图片 URL 格式：mmbiz_qpic.cn/mmbiz_gif/... （注意：URL 不以 .gif 结尾，格式标识在路径中）
    // 同时也兼容常规 .gif 后缀的 URL
    var srcLower = rawSrc.toLowerCase();
    if (srcLower.indexOf("/mmbiz_gif/") > -1 || srcLower.endsWith(".gif") || srcLower.indexOf(".gif?") > -1 || srcLower.indexOf(".gif&") > -1) return;
    // 过滤微信UI垃圾图片和视频封面
    var parent = img.parentElement;
    // 视频标签（video）内的图片、视频封面图直接跳过
    var isVideo = false;
    var walk = img;
    while (walk && walk !== el) {
      if (walk.tagName === "VIDEO" || (walk.getAttribute && walk.getAttribute("data-vid"))) { isVideo = true; break; }
      walk = walk.parentElement;
    }
    // 微信底部栏垃圾：关注按钮、公众号卡片、分享按钮、视频控件
    var imgAlt = (img.alt || "").trim();
    var imgClass = (img.getAttribute("class") || "") + " " + (parent ? (parent.getAttribute("class") || "") : "");
    var junkKeywords = ["已关注", "关注", "分享", "赞", "在看", "更多", "退出全屏", "切换到", "倍速播放", "播放进度", "全屏", "您的浏览器不支持", "观看更多", "珍爱包叔", "写下你的评论"];
    // BUG-2修复：同时检查 alt、文件名、和图片附近文字
    var fileNameJunk = (rawSrc.split("/").pop().split("?")[0] || "");
    // 扩展：向后查3个兄弟+父元素兄弟的文字，捕获跨 section 的推广图文
    var nearTextForJunk = "";
    var sib = img.nextElementSibling;
    for (var si = 0; si < 3 && sib; si++) {
      nearTextForJunk += (sib.innerText || "");
      sib = sib.nextElementSibling;
    }
    // 也检查父元素兄弟（推广图可能和推广文字在不同 section 内）
    if (parent) {
      var parentSib = parent.nextElementSibling;
      for (var pi = 0; pi < 2 && parentSib; pi++) {
        nearTextForJunk += (parentSib.innerText || "");
        parentSib = parentSib.nextElementSibling;
      }
    }
    var isJunk = junkKeywords.some(function(kw) { return imgAlt.indexOf(kw) > -1 || fileNameJunk.indexOf(kw) > -1 || nearTextForJunk.indexOf(kw) > -1; });
    // 公众号卡片区域（通常在文章底部 #mp_name_icon 附近）
    var isCardArea = !!(img.closest && img.closest('#mp_name_icon, .rich_media_tool, .reward_pannel, .article_bar, .profile_nickname, .reward_qrcode'));
    if (isVideo || isJunk || isCardArea) return;
    var caption = "";
    var captionNode = null;  // 记录 caption 对应的 DOM 节点，替换图片时同步删除
    
    // caption 多维打分模型（替换原 isNarrativeText 二元判断）
    // 分数 >= 60 → 认定为图注；< 60 → 认定为正文
    function scoreCaptionCandidate(txt) {
      if (!txt || txt.length < 2) return 0;
      var score = 50;
      var len = txt.length;
      // 长度维度：图注通常短小
      if (len >= 4 && len <= 20) score += 30;
      else if (len <= 35) score += 15;
      else if (len <= 50) score += 0;
      else score -= 40;
      // 自动生成的图片 ID（微信 alt 属性，如 image-20260509102252096）
      if (/^image[-_]\d{10,}/.test(txt)) score -= 50;
      // 句号维度：图注通常0~1个句号
      var sentences = (txt.match(/[。！？!?]/g) || []).length;
      if (sentences === 0) score += 20;
      else if (sentences === 1) score += 5;
      else score -= 30;
      // 图注特有标记词（强特征）
      if (/^(图[：:\/]|图片[：:]|来源[：:]|数据[：:]|资料[：:]|摄[：:]|©|注[：:])/.test(txt)) score += 40;
      if (/^(▲|△|↑|【图】|【注】)/.test(txt)) score += 35;
      if (/(摄影|拍摄|供图|截图|示意图|资料图|配图)/.test(txt)) score += 25;
      // 图注内容特征：描述性名词短语、场景定格、人物/地点定位
      if (/[\(（]\d{4}[\-—~至]\d{0,4}[\)）]/.test(txt)) score += 20;     // 含年份区间括号如（1919-2001）
      if (/(封面|海报|剧照|宣传画|宣传照|合影|留念|留影|肖像)/.test(txt)) score += 20; // 视觉媒介相关词
      if (/^(左起|右起|上起|前排|后排|图中|图左|图右|图上|图下)/.test(txt)) score += 25; // 图片方位描述开头
      if (/[\u4e00-\u9fff]{1,3}(官员|战士|士兵|飞行员|军人|将领|市民|民众|难民|百姓)/.test(txt) && !/(回到|来到|走到|逃到|跑回|赶来|出发|前往|奔赴|撤离|撤退|渡过|翻越|穿过)/.test(txt)) score += 15; // 人物身份描述（排除动态叙述动词）
      if (/(进行|参与|举行|举办|开展|发起|组织|参加|出席)(了|的)?[\u4e00-\u9fff]{2,}/.test(txt) && !/(因此|从而|使得|导致|引发|推动|不仅|而且)/.test(txt)) score += 15; // 事件行为词+无展开连词
      // 叙述性开头扣分（"从…到…"并列结构常见于图注，不扣分）
      // 注意：排除"看到/感到/得到"等动词复合词中的"到"，只匹配真正的"从X到Y"并列
      var isCongDaoStructure = /^从/.test(txt) && /^从.{1,15}(到|至)/.test(txt) && !/(看到|感到|得到|想到|回到|走到|来到|找到|达到|遇到|拿到|起到|收到|碰到|转到|回到|料到|办到|做到|买到|传到|递到)/.test(txt) && len <= 35;
      if (isCongDaoStructure) { /* "从A到B"图注结构，不扣分 */ }
      // 时间/方式状语开头——叙述性正文极强信号，不论长度都扣分
      else if (/^(当|随着|通过|经过|据|根据)/.test(txt)) score -= 50;
      // 代词/介词开头+长度>15——叙述性正文信号
      else if (/^(这|那|他|她|它|我|你|我们|他们|她们|从|在|到|把|被)/.test(txt) && len > 15) score -= 35;
      // "这/那"+量词+视觉媒介词+叙述动词——典型正文模式（如"这组照片记录了..."）
      if (/^(这|那)(个|些|组|幅|张|场|部|段|篇|本|类|种|批|项)/.test(txt) && /(记录|反映|展现|揭示|呈现|说明|证明|体现|表达|描述|讲述|回顾)/.test(txt)) score -= 15;
      // 时间线叙述开头扣分（但含视觉媒介词时不扣，如"1938年5月，登上封面"）
      var hasVisualMedia = /(封面|海报|剧照|宣传|画面|照片|影像)/.test(txt);
      if (/^(\d{4}年|去年|今年|明年|此前|后来|随后|最近|不久|当时|期间)/.test(txt) && !hasVisualMedia) score -= 30;
      // 转折/论证词开头（强正文信号）
      if (/^(但是|然而|不过|因此|所以|于是|此外|同时|另外|至于|值得一提|值得注意|需要指出|事实上|实际上|举个例子|整体来看|总体来看|总的来看|简而言之|总而言之|换句话说|也就是说|由此可见|不难看出|不难发现)/.test(txt)) score -= 50;
      // 动态叙述特征（"了/着/过"句式）
      if (/[\u4e00-\u9fff]{2,}(了|着|过|起来|下去)[，。！？]/.test(txt) && len > 20) score -= 25;
      return score;
    }
    function isLikelyCaption(txt, threshold) { return scoreCaptionCandidate(txt) >= (threshold || 60); }
    
    // 路径1：FIGURE > figcaption
    var parent = img.parentElement;
    if (parent && parent.tagName === "FIGURE") {
      var fc = parent.querySelector("figcaption");
      if (fc) { var fcText = fc.innerText.trim(); if (isLikelyCaption(fcText)) { caption = fcText; captionNode = fc; } }
    }
    // 路径2：直接下一个兄弟
    if (!caption) {
      var sibling = img.nextElementSibling;
      if (sibling) {
        if (sibling.tagName === "FIGCAPTION") { var fcTxt = sibling.innerText.trim(); if (isLikelyCaption(fcTxt)) { caption = fcTxt; captionNode = sibling; } }
        else if (sibling.nodeType === 3 && sibling.textContent.trim()) { caption = sibling.textContent.trim(); captionNode = sibling; }
        else if (sibling.tagName === "P" && sibling.innerText.trim().length > 0 && sibling.innerText.trim().length < 50 && sibling.innerText.trim() !== "图片") {
          // BUG-1修复：叙述性正文检测，防止首段文字被误判为caption
          var sibText2 = sibling.innerText.trim();
          if (isLikelyCaption(sibText2)) { caption = sibText2; captionNode = sibling; }
        }
        else if (sibling.tagName === "SPAN" && sibling.innerText.trim().length > 0 && sibling.innerText.trim() !== "图片") { var spanTxt = sibling.innerText.trim(); if (isLikelyCaption(spanTxt)) { caption = spanTxt; captionNode = sibling; } }
      }
    }
    // 路径3：父元素内的后续兄弟（微信常见：p>img + p>图注 或 p>img + span>图注）
    if (!caption && parent) {
      var found = false;
      var siblings = Array.from(parent.children);
      for (var si = 0; si < siblings.length; si++) {
        if (found) {
          var sib = siblings[si];
          var txt = (sib.innerText || sib.textContent || "").trim();
          if (txt && txt !== "图片" && txt.length > 0 && isLikelyCaption(txt, 60)) {
            caption = txt; captionNode = sib;
            break;
          } else if (sib.tagName === "IMG" || sib.tagName === "BR") {
            continue;
          } else if (!isLikelyCaption(txt, 60)) {
            break;
          }
        }
        if (siblings[si] === img) found = true;
      }
    }
    // 路径4：向上查找父链中的相邻段落（深层嵌套如 section>p>img / section>p>图注）
    if (!caption) {
      var walk = parent;
      while (walk && walk !== el) {
        var walkParent = walk.parentElement;
        if (walkParent) {
          var walkSibs = Array.from(walkParent.children);
          for (var wi = 0; wi < walkSibs.length; wi++) {
            if (walkSibs[wi] === walk && wi + 1 < walkSibs.length) {
              var nextWalk = walkSibs[wi + 1];
              var wTxt = (nextWalk.innerText || nextWalk.textContent || "").trim();
              if (wTxt && wTxt !== "图片" && wTxt.length > 0 && isLikelyCaption(wTxt, 60)) {
                caption = wTxt; captionNode = nextWalk;
                break;
              }
            }
          }
        }
        if (caption) break;
        walk = walkParent;
      }
    }
    // 路径5：上一个兄弟节点
    if (!caption) {
      var prev = img.previousElementSibling;
      if (prev && prev.tagName === "P" && prev.innerText.trim().length > 0 && prev.innerText.trim().length <= 30 && prev.innerText.trim() !== "图片") {
        var prevTxt = prev.innerText.trim();
        if (isLikelyCaption(prevTxt)) { caption = prevTxt; captionNode = prev; }
      }
    }
    // 路径6：img.alt（最后兜底，需过打分模型，避免自动生成的 ID 被当图注）
    if (!caption && img.alt && img.alt.trim() !== "图片") {
      var altText = img.alt.trim();
      if (isLikelyCaption(altText)) caption = altText;
    }
    
    // 路径7：父元素内img后的文本/兄弟短文本（微信：<p>图片+说明</p> 或 <p>图</p><p>较长图注文字</p>）
    // 统一走打分模型（门槛60）
    if (!caption && parent) {
      var pText = "";
      // 先看父元素中img之后的text node
      var afterImg = false;
      for (var ni2 = 0; ni2 < parent.childNodes.length; ni2++) {
        var nd2 = parent.childNodes[ni2];
        if (nd2 === img) { afterImg = true; continue; }
        if (!afterImg) continue;
        if (nd2.nodeType === 3) {
          var t3 = nd2.textContent.trim();
          if (t3) pText += (pText ? " " : "") + t3;
        }
      }
      // 再看后面兄弟元素中的文本
      if (!pText || pText.length < 2) {
        var sib2 = img.nextElementSibling;
        while (sib2) {
          var st2 = (sib2.innerText || "").trim();
          if (st2 && st2 !== "图片") {
            if (isLikelyCaption(st2, 60)) { pText = st2; break; }
          }
          if (sib2.tagName === "IMG" || sib2.tagName === "BR") { sib2 = sib2.nextElementSibling; continue; }
          break;
        }
      }
      if (pText && pText.length > 1 && isLikelyCaption(pText, 60)) { caption = pText; captionNode = null; }
    }

    // 路径8：相邻 section 容器内的独立短文本（同样需要严格化）
    if (!caption) {
      var secCheck = parent;
      while (secCheck && secCheck !== el) {
        if (secCheck.tagName === "SECTION" || (secCheck.getAttribute && secCheck.getAttribute("data-style"))) break;
        secCheck = secCheck.parentElement;
      }
      if (secCheck && secCheck.parentElement) {
        var secSibs2 = Array.from(secCheck.parentElement.children);
        for (var si2 = 0; si2 < secSibs2.length; si2++) {
          if (secSibs2[si2] === secCheck && si2 + 1 < secSibs2.length) {
            var ns2 = secSibs2[si2 + 1];
            var nst2 = (ns2.innerText || "").trim();
            if (nst2 && nst2 !== "图片" && isLikelyCaption(nst2)) { caption = nst2; captionNode = ns2; }
            break;
          }
        }
      }
    }

    var idx = imgCounter;
    imgCounter++;
    var ph = document.createElement("span");
    ph.innerText = "\n\n{{IMG_" + idx + "}}\n";
    img.replaceWith(ph);
    // 替换图片后，同步删除已识别的 caption DOM 节点，防止 htmlToMarkdown 再次输出
    if (captionNode && captionNode.parentElement) {
      captionNode.remove();
    }
    imageMap.push({ idx: idx, src: rawSrc.split("#")[0], caption: caption });
  });
  // === HTML → Markdown 递归转换 ===
  function parseInlineStyle(styleStr) {
    var result = {};
    if (!styleStr) return result;
    styleStr.split(";").forEach(function(pair) {
      var parts = pair.split(":");
      if (parts.length >= 2) {
        var key = parts[0].trim().toLowerCase();
        var val = parts.slice(1).join(":").trim().toLowerCase();
        result[key] = val;
      }
    });
    return result;
  }

  function extractFontSize(styleObj) {
    var fs = styleObj["font-size"] || "";
    var match = fs.match(/([\d.]+)/);
    return match ? parseFloat(match[1]) : 0;
  }

  function isBold(styleObj, tagName) {
    if (tagName === "STRONG" || tagName === "B") return true;
    var fw = styleObj["font-weight"] || "";
    if (fw === "bold" || fw === "700" || fw === "800" || fw === "900") return true;
    var fwNum = parseInt(fw);
    if (fwNum >= 700) return true;
    return false;
  }

  function isItalic(styleObj, tagName) {
    if (tagName === "EM" || tagName === "I") return true;
    var fi = styleObj["font-style"] || "";
    return fi === "italic";
  }

  function extractColor(styleObj) {
    return styleObj["color"] || "";
  }

  // 判断颜色是否为红/橙色系（标题强调色）
  // 中文排版惯例：只有红/橙色用于标题强调，蓝/绿/紫是普通文字色
  // 红/橙色特征：R 分量高(>150)，G/B 分量相对低(R > G*1.5 且 R > B*1.5)
  // 也包括命名色 red/orange 及 hex 红色系(如 #ab1942)
  function isTitleColor(colorStr) {
    if (!colorStr || colorStr === "inherit") return false;
    var norm = colorStr.replace(/\s/g, "").toLowerCase();
    // 命名色
    if (norm === "red" || norm === "orange" || norm.indexOf("crimson") > -1) return true;
    // rgb() 格式
    var rgb = norm.match(/^rgb\((\d+),(\d+),(\d+)\)$/);
    if (rgb) {
      var r = parseInt(rgb[1]), g = parseInt(rgb[2]), b = parseInt(rgb[3]);
      // 近黑色不算
      if (r <= 60 && g <= 60 && b <= 60) return false;
      // 红/橙色：R 明显高于 G 和 B
      return r > 150 && r > g * 1.5 && r > b * 1.5;
    }
    // hex 格式
    var hxMatch = norm.match(/^#([0-9a-f]{3,6})$/);
    if (hxMatch) {
      var hx = hxMatch[1];
      if (hx.length === 3) hx = hx[0]+hx[0]+hx[1]+hx[1]+hx[2]+hx[2];
      var hr = parseInt(hx.substring(0,2),16);
      var hg = parseInt(hx.substring(2,4),16);
      var hb = parseInt(hx.substring(4,6),16);
      if (hr <= 60 && hg <= 60 && hb <= 60) return false;
      return hr > 150 && hr > hg * 1.5 && hr > hb * 1.5;
    }
    return false;
  }

  function isUnderline(styleObj) {
    var td = styleObj["text-decoration"] || "";
    return td.indexOf("underline") > -1;
  }

  function isLineThrough(styleObj) {
    var td = styleObj["text-decoration"] || "";
    return td.indexOf("line-through") > -1;
  }

  function hasBackgroundColor(styleObj) {
    return !!styleObj["background-color"];
  }

  function hasBorderLeft(styleObj) {
    return !!styleObj["border-left"];
  }

  function getDirectTextLength(node) {
    var len = 0;
    node.childNodes.forEach(function(child) {
      if (child.nodeType === 3) len += (child.textContent || "").trim().length;
      else if (child.nodeType === 1 && (child.tagName === "BR" || child.tagName === "IMG")) len += 0;
      else len += (child.textContent || "").trim().length;
    });
    return len;
  }

  function htmlToMarkdown(node) {
    if (!node) return "";
    if (node.nodeType === 3) {
      var t = node.textContent || "";
      return t;
    }
    if (node.nodeType !== 1) return "";
    var tag = node.tagName;
    if (tag === "BR") return "  \n";
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "SVG") return "";
    if (tag === "IMG") return "";

    // --- 标题标签（尊重 HTML 语义层级）---
    // 微信原生排版几乎不用 h 标签（标题走 section+bold+大字号启发式）
    // 第三方编辑器（135/秀米等）可能用 h2-h4
    // H1/H2→## 章节标题，H3→### 子标题，H4→#### 更小标题
    if (tag === "H1") return "## " + processChildren(node) + "\n\n";
    if (tag === "H2") return "## " + processChildren(node) + "\n\n";
    if (tag === "H3") return "### " + processChildren(node) + "\n\n";
    if (tag === "H4") return "#### " + processChildren(node) + "\n\n";
    if (tag === "H5") return "##### " + processChildren(node) + "\n\n";
    if (tag === "H6") return "###### " + processChildren(node) + "\n\n";

    // --- 引用块 ---
    if (tag === "BLOCKQUOTE") {
      var bqRaw = processChildren(node);
      // 按行分割，过滤空白行，再组装引用
      var bqLines = bqRaw.split("\n").filter(function(l) { return l.trim().length > 0; });
      var bqClean = bqLines.join("\n> ");
      if (bqClean.trim()) return "\n> " + bqClean + "\n\n";
      return "";
    }

    // --- 列表 ---
    if (tag === "UL" || tag === "OL") {
      var listItems = [];
      var isOrdered = (tag === "OL");
      var liIdx = 1;
      node.querySelectorAll(":scope > li").forEach(function(li) {
        var liContent = processChildren(li).trim();
        if (isOrdered) {
          // 检测 li 内容是否自带编号（如 "1. " "1、 " "1 "），避免双重编号
          var hasOwnNum = /^\d+[\.\、\s]\s*/.test(liContent);
          listItems.push(hasOwnNum ? liContent : liIdx + ". " + liContent);
        } else {
          listItems.push("- " + liContent);
        }
        liIdx++;
      });
      return "\n" + listItems.join("\n") + "\n\n";
    }

    // --- 代码块 ---
    if (tag === "PRE") {
      var codeNodes = node.querySelectorAll("code");
      var codeText;
      if (codeNodes.length > 0) {
        codeText = Array.from(codeNodes).map(function(c) {
          return (c.textContent || "").trim();
        }).join("\n");
      } else {
        codeText = (node.textContent || "").trim();
      }
      return "\n```\n" + codeText + "\n```\n\n";
    }
    if (tag === "CODE") return processChildren(node);

    // --- 行内代码 ---
    // (CODE in non-PRE context handled by parent)

    // --- 分割线 ---
    if (tag === "HR") return "\n---\n\n";

    // --- 表格 ---
    if (tag === "TABLE") {
      var rows = Array.from(node.querySelectorAll("tr"));
      if (rows.length === 0) return processChildren(node);
      var mdRows = [];
      var headerDone = false;
      rows.forEach(function(row) {
        var cells = Array.from(row.querySelectorAll("th, td"));
        if (cells.length === 0) return;
        var cellTexts = cells.map(function(cell) {
          return (cell.innerText || cell.textContent || "").trim().replace(/\n/g, " ").replace(/\|/g, "\\|");
        });
        mdRows.push("| " + cellTexts.join(" | ") + " |");
        if (!headerDone) {
          mdRows.push("| " + cellTexts.map(function() { return "---"; }).join(" | ") + " |");
          headerDone = true;
        }
      });
      return "\n\n" + mdRows.join("\n") + "\n\n";
    }
    // TR/TD/TH/TBODY/THEAD 由 TABLE 统一处理，单独遇到时只递归子节点
    if (tag === "TR" || tag === "TD" || tag === "TH" || tag === "TBODY" || tag === "THEAD" || tag === "CAPTION") {
      return processChildren(node);
    }

    // --- section ---
    if (tag === "SECTION") {
      var secStyle = parseInlineStyle(node.getAttribute("style"));
      // 启发式标题检测（多规则组合）：
      // 规则A：字号 >= 18px + bold + 短文字 (< 30字)
      // 规则B：字号 >= 16px + bold + 极短文字 (<= 5字，如 "1" "2" 等章节编号)
      // 规则C（fallback）：字号 >= 20px + 独占一行（前后无其他同级section文本）+ 非超长文字
      var secFs = extractFontSize(secStyle);
      var secBold = isBold(secStyle, tag);
      var secTextLen = getDirectTextLength(node);
      // 检查是否独占一行：前一个兄弟和后一个兄弟都是空/无文本
      var prevSibling = node.previousElementSibling;
      var nextSibling = node.nextElementSibling;
      var prevHasText = prevSibling ? getDirectTextLength(prevSibling) > 0 : false;
      var nextHasText = nextSibling ? getDirectTextLength(nextSibling) > 0 : false;
      var isStandalone = !prevHasText && !nextHasText;
      var isSecTitle = (secFs >= 18 && secBold && secTextLen > 0 && secTextLen < 30) ||
                        (secFs >= 16 && secBold && secTextLen > 0 && secTextLen <= 5) ||
                        (secFs >= 20 && isStandalone && secTextLen > 0 && secTextLen < 40);
      if (isSecTitle) {
        // 提取纯文本，避免子节点 span 再被加粗处理导致 ## **标题##
        var secPlainText = (node.innerText || node.textContent || "").trim();
        // 双换行确保标题独占一行（前面可能紧贴着段落文字）
        return "\n\n### " + secPlainText + "\n\n";
      }
      // 普通section：递归子节点
      return processChildren(node);
    }

    // --- 段落 ---
    if (tag === "P") {
      // blockquote 祖先检查：引用块内的 P 不做标题检测，保持引用结构
      var inBlockquote = false;
      var bqWalk = node.parentElement;
      while (bqWalk && bqWalk !== el) {
        if (bqWalk.tagName === "BLOCKQUOTE") { inBlockquote = true; break; }
        bqWalk = bqWalk.parentElement;
      }
      if (!inBlockquote) {
      // BUG-6修复：检测章节标题（微信公众号常见：font>p>span(red)+span(bold)>编号标题文字）
      // 特征链：<p> 的直接子元素是一个 span，该 span 包含红色文字 + bold 外层包裹
      // 文本格式如 "03. 偏安的结构"、"04. 尾声"，匹配 \d+\.\s+标题
      // 这类标题的 DOM 结构是: P > FONT > SPAN(bold) > SPAN(color:red) > "03. xxx"
      var pChildren = Array.from(node.children);
      var isChapterTitle = false;
      var chapterText = "";
      // 规则1：p 的唯一直接子元素是 font/font 被跳过后的第一个子元素
      for (var pc = 0; pc < pChildren.length; pc++) {
        var pChild = pChildren[pc];
        // 跳过 font 包装标签
        if (pChild.tagName === "FONT") {
          var fontKids = Array.from(pChild.children);
          if (fontKids.length === 1) {
            pChild = fontKids[0];
          } else if (fontKids.length > 1) {
            break; // font 下有多个子元素，不可能是简单标题
          }
        }
        // 检查是否为单个 span 子元素
        if (pChild.tagName === "SPAN" && pChildren.length <= 2) {
          var pChildStyle = parseInlineStyle(pChild.getAttribute("style"));
          var pChildBold = isBold(pChildStyle, pChild.tagName);
          // 再检查其内部是否有红色 span
          var innerSpans = pChild.querySelectorAll(":scope > span");
          var hasRedSpan = false;
          if (innerSpans.length >= 1) {
            for (var rs = 0; rs < innerSpans.length; rs++) {
              var innerStyle = parseInlineStyle(innerSpans[rs].getAttribute("style"));
              var innerColor = extractColor(innerStyle);
              // 微信文章红色标题色值通常包含 rgb(171,25,66) 或类似红色
              if (innerColor && (innerColor.indexOf("171") > -1 || innerColor.indexOf("ab1942") > -1 || innerColor.indexOf("rgb(171") > -1 || innerColor.indexOf("red") > -1)) {
                hasRedSpan = true;
                break;
              }
            }
          }
          // 也检查自身颜色（有些结构没有内层红色 span）
          var selfColor = extractColor(pChildStyle);
          if (!hasRedSpan && selfColor && (selfColor.indexOf("171") > -1 || selfColor.indexOf("ab1942") > -1 || selfColor.indexOf("red") > -1)) {
            hasRedSpan = true;
          }
          var pRawText = (node.innerText || node.textContent || "").trim();
          // 编号格式: 数字. 空格 文字（如 "01. 霸屏的戏骨"、"03. 偏安的结构"、"03. 隐患"）
          // 条件：红色 OR 加粗 + 编号格式 + 短文本（<=30字）
          if ((hasRedSpan || pChildBold) && pRawText.match(/^(0?[1-9])\.\s+/) && pRawText.length < 30) {
            isChapterTitle = true;
            chapterText = pRawText;
          }
        }
        break; // 只检查第一个有效子元素
      }
      if (isChapterTitle && chapterText) {
        return "\n\n### " + chapterText + "\n\n";
      }
      // BUG-6扩展规则：P 下有多个 SPAN，其中至少一个是非黑色彩色，且整段 ≤ 30 字 → 章节标题
      // 捕获如 "长期主义是一个奢侈品"（一黑一红两个 SPAN 拼成）
      // 排除：文献标号 [N] 开头的行（如 "[1] 凛冬将至：电视剧笔记，毛尖"）
      if (!isChapterTitle) {
        var pRawText2 = (node.innerText || node.textContent || "").trim();
        if (pRawText2.length > 0 && pRawText2.length <= 30 && !/^\[\d+\]/.test(pRawText2)) {
          var directSpans = Array.from(node.querySelectorAll(":scope > span"));
          if (directSpans.length === 0) {
            // 可能 font 包裹了 span
            var fontWrap = node.querySelector(":scope > font");
            if (fontWrap) directSpans = Array.from(fontWrap.querySelectorAll(":scope > span"));
          }
          var hasColorSpan = false;
          for (var ds = 0; ds < directSpans.length; ds++) {
            var dsStyle = parseInlineStyle(directSpans[ds].getAttribute("style"));
            var dsColor = extractColor(dsStyle);
            if (isTitleColor(dsColor)) { hasColorSpan = true; break; }
          }
          if (hasColorSpan && directSpans.length >= 1) {
            return "\n\n### " + pRawText2 + "\n\n";
          }
        }
      }
      // 兜底规则：P 的全部内容是单个短彩色文本（红/橙色系）→ 判定为章节标题
      // 捕获如 "03. 隐患" 这类纯红色标题（无 bold、无 font 包装）
      // 排除：图注特征 — 含 | / 含中文年份(年) / 纯数字开头(图序号)
      if (!isChapterTitle && pRawText && pRawText.length <= 12 && pRawText.length > 0) {
        var hasCaptionFeatures = pRawText.includes("|") ||
          /[0-9]{4}年/.test(pRawText) || /^\d+[\.、\s]/.test(pRawText);
        if (!hasCaptionFeatures) {
          var allSpans = node.querySelectorAll("span");
          var hasTitleColor = false;
          for (var ci = 0; ci < allSpans.length; ci++) {
            var cStyle = parseInlineStyle(allSpans[ci].getAttribute("style"));
            var cColor = extractColor(cStyle);
            if (isTitleColor(cColor)) { hasTitleColor = true; break; }
          }
          if (hasTitleColor) {
            return "\n\n### " + pRawText + "\n\n";
          }
        }
      } // end if (!isChapterTitle && pRawText...)
      } // end if (!inBlockquote)
      var pResult = processChildren(node);
      return pResult + "\n\n";
    }

    // --- span：检查内联样式 ---
    if (tag === "SPAN") {
      var spStyle = parseInlineStyle(node.getAttribute("style"));
      var inner = processChildren(node);
      if (!inner.trim()) return "";

      // 多种样式叠加
      var prefix = "";
      var suffix = "";

      // 颜色处理：用 Obsidian 支持的 HTML <span style="color:..."> 保留原文颜色
      var spColor = extractColor(spStyle);
      // 判断是否为"近黑色/深灰色"（微信正文默认色，不需要标注）
      // 策略：解析 RGB 值，三个通道都 <= 60 的视为正文默认色
      // 覆盖：rgb(0,0,0)、rgb(31,35,41)、rgb(34,34,34)、rgb(51,51,51) 等
      // 也覆盖 rgba(0,0,0,0.7+) 格式
      var isNearBlack = false;
      if (spColor && spColor !== "inherit") {
        var cNorm = spColor.replace(/\s/g, "");
        // 匹配 rgb(r,g,b) 格式
        var rgbMatch = cNorm.match(/^rgb\((\d+),(\d+),(\d+)\)$/);
        if (rgbMatch) {
          var r = parseInt(rgbMatch[1]), g = parseInt(rgbMatch[2]), b = parseInt(rgbMatch[3]);
          if (r <= 60 && g <= 60 && b <= 60) isNearBlack = true;
        }
        // 匹配 rgba(0,0,0,alpha) 格式
        else if (cNorm.match(/^rgba\(0,0,0,0\.[7-9]\)$/)) {
          isNearBlack = true;
        }
        // 匹配 hex 格式
        else if (cNorm.match(/^#([0-9a-f]{3,6})$/)) {
          var hex = cNorm.substring(1);
          if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
          var hr = parseInt(hex.substring(0,2), 16);
          var hg = parseInt(hex.substring(2,4), 16);
          var hb = parseInt(hex.substring(4,6), 16);
          if (hr <= 60 && hg <= 60 && hb <= 60) isNearBlack = true;
        }
      }
      if (spColor && !isNearBlack) {
        prefix = '<span style="color:' + spColor + '">' + prefix;
        suffix = suffix + '</span>';
      }

      // 加粗：span 的 font-weight:bold 只对短文本生效（<=20字=语义强调如书名/关键词，>20字=容器样式不输出**）
      if (isBold(spStyle, tag) && inner.trim().length > 0 && inner.trim().length <= 20) {
        prefix += "**";
        suffix = "**" + suffix;
      }

      // 斜体
      if (isItalic(spStyle, tag)) {
        prefix += "*";
        suffix = "*" + suffix;
      }

      // 下划线
      if (isUnderline(spStyle)) {
        prefix += "<u>";
        suffix = "</u>" + suffix;
      }

      // 删除线
      if (isLineThrough(spStyle)) {
        prefix += "~~";
        suffix = "~~" + suffix;
      }

      return prefix + inner + suffix;
    }

    // --- strong / b ---
    if (tag === "STRONG" || tag === "B") {
      var inner = processChildren(node).trim();
      if (!inner) return "";  // 空 strong/b 不输出
      // 检查 strong/b 自身是否有颜色样式
      var bStyle = parseInlineStyle(node.getAttribute("style"));
      var bColor = extractColor(bStyle);
      // 近黑色判断（同 SPAN 逻辑：RGB通道值<=60视为正文默认色）
      var bIsNearBlack = false;
      if (bColor && bColor !== "inherit") {
        var bcNorm = bColor.replace(/\s/g, "");
        var bRgbMatch = bcNorm.match(/^rgb\((\d+),(\d+),(\d+)\)$/);
        if (bRgbMatch) {
          if (parseInt(bRgbMatch[1]) <= 60 && parseInt(bRgbMatch[2]) <= 60 && parseInt(bRgbMatch[3]) <= 60) bIsNearBlack = true;
        } else if (bcNorm.match(/^rgba\(0,0,0,0\.[7-9]\)$/)) {
          bIsNearBlack = true;
        } else if (bcNorm.match(/^#([0-9a-f]{3,6})$/)) {
          var bhex = bcNorm.substring(1);
          if (bhex.length === 3) bhex = bhex[0]+bhex[0]+bhex[1]+bhex[1]+bhex[2]+bhex[2];
          if (parseInt(bhex.substring(0,2),16) <= 60 && parseInt(bhex.substring(2,4),16) <= 60 && parseInt(bhex.substring(4,6),16) <= 60) bIsNearBlack = true;
        }
      }
      if (bColor && !bIsNearBlack) {
        return '<span style="color:' + bColor + '">**' + inner + '**</span>';
      }
      return "**" + inner + "**";
    }

    // --- em / i ---
    if (tag === "EM" || tag === "I") {
      return "*" + processChildren(node) + "*";
    }

    // --- u ---
    if (tag === "U") {
      return "<u>" + processChildren(node) + "</u>";
    }

    // --- s / del ---
    if (tag === "S" || tag === "DEL" || tag === "STRIKE") {
      return "~~" + processChildren(node) + "~~";
    }

    // --- a 链接 ---
    if (tag === "A") {
      var href = node.getAttribute("href") || "";
      var linkText = processChildren(node);
      if (href) return "[" + linkText + "](" + href + ")";
      return linkText;
    }

    // --- 其他标签：递归子节点 ---
    return processChildren(node);
  }

  function processChildren(node) {
    var result = "";
    node.childNodes.forEach(function(child) {
      result += htmlToMarkdown(child);
    });
    return result;
  }

  // 调用转换，try-catch 兜底
  var text = "";
  try {
    text = htmlToMarkdown(clone);
    // 清理多余空行（3个以上换行 → 2个）
    text = text.replace(/\n{3,}/g, "\n\n");
    // 清理列表项间的空行
    text = text.replace(/(\n- .*)\n\n(- )/g, "$1\n$2");
    text = text.replace(/(\n\d+\. .*)\n\n(\d+\. )/g, "$1\n$2");
    
    // 去重：连续相同或高度相似的段落（引用+纯文本重复）
    // 微信文章中同一段文字常出现在 section 引用 + 普通段落中
    var lines = text.split("\n");
    var deduped = [];
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      var prevLine = deduped.length > 0 ? deduped[deduped.length - 1] : "";
      // 如果当前行和前一行内容完全一致（忽略 > 前缀），跳过
      var curClean = line.replace(/^>\s*/, "").trim();
      var prevClean = prevLine.replace(/^>\s*/, "").trim();
      if (curClean && curClean === prevClean) continue;
      deduped.push(line);
    }
    text = deduped.join("\n");
    // 清理残留的空格式标记：独立成行的 ****（空 strong/em 嵌套产生）
    text = text.replace(/^[\s]*\*{3,}[\s]*$/gm, "");
    // 清理独立成行的 **（单侧加粗标记残留，如微信章节分隔符）
    text = text.replace(/^[\s]*\*{1,2}[\s]*$/gm, "");
    // 清理段首段尾粘连的 ****（如 "****文字" 或 "文字****"）
    text = text.replace(/^(\s*)\*{4,}/gm, "$1");
    text = text.replace(/\*{4,}(\s*)$/gm, "$1");
    // 清理文字中间粘连的 ****（如 "文字****更多文字" → "文字更多文字"）
    // 不用 lookahead（Claudian V8 可能不支持），用普通捕获组替代
    text = text.replace(/([^*\s])\*{4,}([^*\s])/g, "$1$2");
    // 再清一遍产生的多余空行
    text = text.replace(/\n{3,}/g, "\n\n");
  } catch(e) {
    text = clone.innerText || clone.textContent;
  }

  // 保存参考资料区域（在截断前提取，避免被底部过滤删掉）
  // 微信文章的参考资料格式：参考资料：\n1. xxx\n2. xxx\n 或 [1] xxx\n[2] xxx\n
  var refSection = "";
  var refMatch = text.match(/(参考资料[：:]?\s*\n(?:[\s\S]*))/);
  if (refMatch) {
    // 只保留参考资料及其条目，遇到明显的非参考内容（如推广块）则截断
    var refRaw = refMatch[1];
    // 如果参考资料后面有推广块（珍爱包叔等），截掉
    var promoInRef = refRaw.indexOf("珍爱包叔");
    if (promoInRef > -1) refRaw = refRaw.substring(0, promoInRef);
    refSection = refRaw.trim();
  }

  // 过滤微信底部栏：从"责任编辑"开始截断（但保留参考资料区域）
  // 先记录参考资料位置，避免被截断
  var refIdx = text.lastIndexOf("参考资料");
  var editorMatch = text.indexOf("责任编辑");
  // 如果"责任编辑"在参考资料之后才截断，否则不截断（避免删掉正文末尾的编辑署名）
  if (editorMatch > -1 && (refIdx === -1 || editorMatch > refIdx)) {
    text = text.substring(0, editorMatch).trim();
  }
  // 也检查其他常见的微信底部标识（同样保护参考资料）
  var bottomKeywords = ["更多精彩", "微信扫一扫", "阅读原文"];
  for (var bi = 0; bi < bottomKeywords.length; bi++) {
    var bIdx = text.indexOf(bottomKeywords[bi]);
    if (bIdx > -1 && bIdx < text.length * 0.95) {
      var currentRefIdx = text.lastIndexOf("参考资料");
      if (currentRefIdx === -1 || bIdx > currentRefIdx) {
        text = text.substring(0, bIdx).trim();
      }
    }
  }
  // 保留文章末尾的作者/编辑署名行（桥爷要求保留）
  // 清理末尾残留的孤立 ** 或 <span>标签
  text = text.replace(/^\s*\*{1,2}\s*$/gm, "");
  text = text.replace(/^\s*<span[^>]*>\*{0,2}\s*$/gm, "");

  // 追加回参考资料（如果截断前提取到了，且截断后丢失了）
  if (refSection && text.indexOf("参考资料") === -1) {
    text = text.trimEnd() + "\n\n" + refSection;
  }
  // BUG-3修复：删除"全文完"类公众号结束语
  text = text.replace(/\n?[^\n]*全文完[^\n]*\n?/g, "");
  // BUG-4修复：删除空标题行（### 后面没有文字）
  // 注意：必须用 $ 锚定行尾，不能匹配正常标题（如 "## Skill 系统"）
  // 旧版 /^#{1,6}\s*\n?/gm 会把 "## 标题" 也删掉（\s* 会吃掉空格）
  text = text.replace(/^#{1,6}\s*$/gm, "");
  // BUG-2修复（补充）：从 text 中删除"珍爱包叔"推广段落
  // 策略：只删除推广图占位符+推广文字本身，不碰相邻的正文图片
  var lines = text.split("\n");
  var promoStart = -1;
  for (var pli = 0; pli < lines.length; pli++) {
    if (lines[pli].indexOf("珍爱包叔") > -1 || lines[pli].indexOf("顺手\"在看") > -1 || lines[pli].indexOf("顺手'在看") > -1) {
      promoStart = pli;
      break;
    }
  }
  if (promoStart > -1) {
    // 向前找：只找紧邻的推广图占位符（不含 caption 的 {{IMG_N}}）
    var promoBlockStart = promoStart;
    for (var pbi = promoStart - 1; pbi >= 0; pbi--) {
      var pLine = lines[pbi].trim();
      if (pLine.match(/^\{\{IMG_\d+\}\}$/)) {
        promoBlockStart = pbi;
        break;
      }
      if (pLine.length > 30) break; // 正文行，停止
      promoBlockStart = pbi;
    }
    // 向后找：遇到正文图片占位符（{{IMG_N}} 独占行）立即停止，不纳入删除范围
    var promoBlockEnd = promoStart + 1;
    for (var pbi2 = promoStart + 1; pbi2 < lines.length; pbi2++) {
      var nLine = lines[pbi2].trim();
      if (nLine.match(/^\{\{IMG_\d+\}\}$/)) break; // 正文图片，停止！
      if (nLine.length > 40) break; // 正常正文
      promoBlockEnd = pbi2 + 1;
    }
    // 删除推广块（推广图+推广文字，但不包括相邻正文图片）
    lines.splice(promoBlockStart, promoBlockEnd - promoBlockStart);
  }
  text = lines.join("\n");
  // 清理豆包AI播客推广行（"*此节目由豆包AI播客生成，感兴趣的朋友可以试听"）
  text = text.replace(/\n\*[^\n]*豆包AI播客生成[^\n]*/g, "");
  // 清理产生的多余空行
  text = text.replace(/\n{3,}/g, "\n\n");
  return JSON.stringify({ text: text, images: imageMap });
})()
