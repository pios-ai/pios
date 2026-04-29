/**
 * tts-sanitize.js — PiOS TTS 文本净化层
 *
 * 统一入口：sanitizeForTTS(text) → string
 * 适用所有走 TTS 的路径：sendNotification / bubble <say> / 任何调用 tts.speak()
 *
 * 处理 6 类干扰：
 * 1. Markdown 标记（**bold**, `code`, [link](url), # heading, - list, > quote）
 * 2. 特殊符号（/, _, ~, |, <, >, {}, [] 等）
 * 3. 长文件路径（/Users/xxx/... 或 ~/PiOS-Vault/...）→ 文件名
 * 4. URL（http/https）→ 域名
 * 5. emoji / 装饰字符 → 去掉
 * 6. 连续标点 / 多余空白 → 规范化
 *
 * 规则执行顺序很重要：URL → 路径 → Markdown → 符号 → emoji → 空白
 * URL 必须最先处理，否则路径规则会截断 URL 中的片段。
 *
 * 测试用例：见文件末尾，node tts-sanitize.js 直接运行。
 */

'use strict';

// ── 规则 1：URL ──────────────────────────────────────────────────────────────
// http://example.com/path?q=1 → "example.com"
// 保留域名比直接删掉信息量更大。
function stripUrls(text) {
  return text.replace(/https?:\/\/([a-zA-Z0-9.-]+)(\/[^\s"'）)】，。！？\]]*)?/g, (_, domain) => domain);
}

// ── 规则 2：长文件路径 ──────────────────────────────────────────────────────
// {vault}/Pi/Output/radar/foo.md → foo.md
// ~/PiOS-Vault/Cards/active/bar.md              → bar.md
// Pi/Output/radar/scan-state/topic.md           → topic.md（4 层以上相对路径）
function stripPaths(text) {
  // 预清理：glob 通配符 /** 和路径末尾孤立的 /（字母后 + 空格/标点前）
  text = text.replace(/\/\*+/g, '');
  text = text.replace(/([a-zA-Z0-9])\/(?=[\s）)、，。,.])/g, '$1');
  // 绝对路径：/Users/xxx/... 或 /home/xxx/... 或 ~/...
  text = text.replace(
    /(?:\/(?:Users|home|tmp|var|etc|opt)\/[^\s"'）)】，。！？]*|~\/[^\s"'）)】，。！？]*)/g,
    (match) => {
      const parts = match.replace(/^~\//, '').replace(/^\/[^/]+\/[^/]+\//, '').split('/').filter(Boolean);
      if (parts.length === 0) return '';
      const last = parts[parts.length - 1];
      const parent = parts[parts.length - 2];
      // 如果最后是目录（无扩展名）且有父目录，写 "parent/last 目录"
      if (parent && !last.includes('.')) return `${parent}/${last}`;
      return last;
    }
  );

  // 相对路径：3 段以上（如 Pi/Output/infra 或 Pi/Output/infra/**）
  // 允许末尾跟 /**（glob 通配符），截短到最后有意义的一段
  text = text.replace(
    /\b([a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+){2,})(\/\*+)?\b/g,
    (match) => {
      const cleaned = match.replace(/\/\*+$/, ''); // 去掉末尾 /** 等 glob
      const parts = cleaned.split('/').filter(Boolean);
      return parts[parts.length - 1];
    }
  );

  return text;
}

// ── 规则 3：Markdown 标记 ────────────────────────────────────────────────────
function stripMarkdown(text) {
  // ```代码块``` → (代码块)
  text = text.replace(/```[\s\S]*?```/g, '代码块');
  // [text](url) → text
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // **bold** or __bold__ → bold
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  text = text.replace(/__([^_\n]+)__/g, '$1');
  // *italic* → italic（不跨行）
  text = text.replace(/\*([^*\n]+)\*/g, '$1');
  // _italic_ → italic（只有前后有空白/边界时才处理，避免 a_b_c 的误判）
  text = text.replace(/(^|\s)_([^_\n]+)_(\s|$)/g, '$1$2$3');
  // `inline code` → code
  text = text.replace(/`([^`\n]+)`/g, '$1');
  // # heading → text（去掉行首 # 号）
  text = text.replace(/^#{1,6}\s+/gm, '');
  // > blockquote
  text = text.replace(/^>\s*/gm, '');
  // - / * / + list item（行首）
  text = text.replace(/^[-*+]\s+/gm, '');
  // | table cell separator → 逗号
  text = text.replace(/\|/g, '，');
  return text;
}

// ── 规则 3.5：技术 token（扩展名 + 单位）──────────────────────────────────
// 中文 clone voice 对英文技术 token（.log / GB / ms）对齐失败 → 口吃。
// 这些是 PiOS 特有词汇，不属于 WeText 通用 TN 范围，在 Node 侧清理。
// 数字/百分号/日期交给服务端 wetext。
const EXT_MAP = {
  log: '日志', md: '文档', json: '配置', yaml: '配置', yml: '配置',
  sh: '脚本', py: '代码', js: '代码', ts: '代码', jsx: '代码', tsx: '代码',
  wav: '音频', mp3: '音频', mp4: '视频', mov: '视频',
  html: '网页', css: '样式', txt: '文本', csv: '表格', pdf: '文档',
  png: '图片', jpg: '图片', jpeg: '图片', gif: '图片', svg: '图形',
  zip: '压缩包', tar: '压缩包', gz: '压缩包',
};
const UNIT_MAP = {
  TB: '太字节', GB: '千兆字节', MB: '兆字节', KB: '千字节',
  ms: '毫秒', us: '微秒', ns: '纳秒',
  kHz: '千赫', MHz: '兆赫', GHz: '千兆赫',
  mm: '毫米', cm: '厘米', km: '千米',
  kg: '千克', mg: '毫克',
  ml: '毫升',
};
function stripTechTokens(text) {
  // 扩展名：foo.log → foo 日志
  text = text.replace(/\b([a-zA-Z0-9_-]+)\.([a-zA-Z]{2,5})\b/g, (m, name, ext) => {
    const zh = EXT_MAP[ext.toLowerCase()];
    return zh ? `${name} ${zh}` : m;
  });
  // 单位：3.2GB / 500 ms → 3.2 千兆字节 / 500 毫秒
  // 单位匹配区分大小写（GB 不同于 gb）
  const unitPattern = new RegExp('(\\d+(?:\\.\\d+)?)\\s*(' + Object.keys(UNIT_MAP).join('|') + ')\\b', 'g');
  text = text.replace(unitPattern, (m, num, unit) => `${num} ${UNIT_MAP[unit]}`);
  return text;
}

// ── 规则 4：特殊符号 ─────────────────────────────────────────────────────────
function stripSymbols(text) {
  // 带扩展名的文件名保留；路径规则已把绝对/相对路径压缩到最后一段，
  // 这里再整体删掉会把 run.log 这类真正有信息量的文件名误杀。
  // 不带扩展名的 kebab-case 保留（可能是卡片名/task 名，有语义）但连字符转空格让 TTS 好念
  text = text.replace(/\b([a-zA-Z0-9]+(?:-[a-zA-Z0-9]+){2,})\b/g, (m) => m.replace(/-/g, ' '));
  // —— 和 — （破折号/长划线）→ 逗号停顿
  text = text.replace(/——/g, '，');
  text = text.replace(/—/g, '，');
  // – (U+2013 en dash) / ‒ (U+2012 figure dash) / ― (U+2015 horizontal bar)
  // 中文 TTS 把 en dash 念成"减"（owner 吐槽的"有'减'这种字读出来"根因）
  // 2026-04-24 补：之前只处理 em dash，漏了 GPT 输出常见的 en dash
  text = text.replace(/[\u2012\u2013\u2015]/g, '，');
  // ～ 全角波浪号 → "到"（常用于范围：04-08～04-16）
  text = text.replace(/～/g, '到');
  // ： 产出/结论后跟技术内容时，冒号本身 TTS 可以处理，保留
  // / 斜杠：路径已处理完，剩下的多为 "A/B" 形式 → "A或B"
  text = text.replace(/\s*\/\s*/g, '或');
  // _ 下划线：identifier 里的分隔符 → 空格
  text = text.replace(/_/g, ' ');
  // ~ 半角波浪号 → 去掉
  text = text.replace(/~/g, '');
  // { } → 去掉
  text = text.replace(/[{}]/g, '');
  // < > → 去掉（已无 HTML tag，被 Markdown 处理过）
  text = text.replace(/[<>]/g, '');
  // [ ] → 去掉（Markdown 链接已处理完）
  text = text.replace(/[\[\]]/g, '');
  // * 剩余星号 → 去掉
  text = text.replace(/\*/g, '');
  // ` 剩余反引号 → 去掉
  text = text.replace(/`/g, '');
  // # 行中间的 # → 去掉（行首已处理）
  text = text.replace(/#/g, '');
  return text;
}

// ── 规则 5：emoji / 装饰字符 ─────────────────────────────────────────────────
function stripEmoji(text) {
  // Emoji Unicode ranges
  text = text.replace(/[\u{1F000}-\u{1FFFF}]/gu, '');
  text = text.replace(/[\u{2600}-\u{27FF}]/gu, '');
  text = text.replace(/[\u{1F300}-\u{1F9FF}]/gu, '');
  text = text.replace(/[\u{FE00}-\u{FEFF}]/gu, ''); // variation selectors
  text = text.replace(/[\u{200D}]/gu, '');           // zero-width joiner
  // 箭头有语义（A → B = "A 变成 B"），换成"，"停顿保留语义，不直接删
  text = text.replace(/[→←↗↘↙↖⇒⇐]/g, '，');
  // 纯装饰上下箭头/图形：删
  text = text.replace(/[↑↓⇑⇓♦♠♣♥★☆■□●○▶▷◀◁▲△▼▽]/g, '');
  return text;
}

// ── 规则 6：连续标点 / 多余空白 ─────────────────────────────────────────────
function normalizeWhitespace(text) {
  // 去掉文件名被删后留下的孤立结构：「产出： ，」「写入 ，」→「产出：」「写入」
  text = text.replace(/([：:]) *[，,]/g, '$1');
  // 多余的连续中文/英文标点 → 单个
  text = text.replace(/([，。！？：；,.!?;:]){2,}/g, '$1');
  // 去掉句首孤立标点（行开头跟着标点）
  text = text.replace(/^[，。；：、]+/gm, '');
  // 换行 → 停顿（中文用顿号节奏感好）
  text = text.replace(/\n{2,}/g, '。');
  text = text.replace(/\n/g, '，');
  // 多个空格 → 单个
  text = text.replace(/[ \t]{2,}/g, ' ');
  // 首尾空白
  text = text.trim();
  return text;
}

// ── 主函数 ───────────────────────────────────────────────────────────────────
/**
 * sanitizeForTTS(text) → string
 *
 * 将任意文本净化为适合 TTS 朗读的纯文字。
 * 按固定顺序应用 6 类规则，顺序不可随意调换。
 */
function sanitizeForTTS(text) {
  if (!text || typeof text !== 'string') return text;
  // 2026-04-24 晚：literal "\n" / "\t" / "\r" 两字节 → real 字符。LLM heredoc
  // 有时输出 `\n` 字面（非 real newline）；TTS 若不归一会把 "反斜杠 n" 念出来。
  text = text.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '');
  text = stripUrls(text);          // 1. URL 先处理
  text = stripPaths(text);         // 2. 路径截短
  text = stripMarkdown(text);      // 3. Markdown 去掉
  text = stripTechTokens(text);    // 3.5 技术 token（扩展名+单位）→ 中文
  text = stripSymbols(text);       // 4. 特殊符号
  text = stripEmoji(text);         // 5. emoji
  text = normalizeWhitespace(text); // 6. 空白整理
  return text;
}

module.exports = { sanitizeForTTS };

// ── 自测（node tts-sanitize.js 直接运行）────────────────────────────────────
if (require.main === module) {
  const cases = [
    ['Emoji in triage', '【triage 02:08】9 张 inbox 卡待审。🔴 P1 行动：task-foo；📌 注意：配置已回退。'],
    ['File path absolute', '报告写入 {vault}/Pi/Output/radar/market-scan.md，请查阅'],
    ['File path tilde', '配置在 ~/PiOS-Vault/Pi/Config/pios.yaml 已更新'],
    ['File path relative 4-level', 'Pi/Output/radar/scan-state/ai-ecommerce.json 已存在同主题报告'],
    ['URL full', '参考 https://github.com/anthropics/claude-code/issues/123 的 PR 说明'],
    ['Markdown bold/list', '**任务完成**：\n- 第一条结果\n- 第二条结果\n- 第三条结果'],
    ['Markdown link', '查看 [完整报告](https://example.com/report) 了解详情'],
    ['Markdown code', '运行 `python3 -m pytest` 验证'],
    ['Special symbols', 'critical/warning 级别告警 {status: done} | key_name_here'],
    ['Verify card exact case', '测试：~/PiOS/Pi/Log/run.log 🔴 emoji critical/warning'],
    ['Underscore identifier', 'openclaw_codex_reauth 任务已派发，auth_pause 已清除'],
    ['Combined real case', '**巡检完成** ✅\n- CPU: 正常\n- 报告: `{vault}/Pi/Log/run.log`\n- 详情: [链接](https://github.com) | 状态: {ok}\n- openclaw/codex 引擎已恢复'],
    ['Heading and blockquote', '## 系统状态\n> 所有服务正常\n**结论**：无需处理'],
  ];

  console.log('=== tts-sanitize 自测 ===\n');
  let passed = 0;
  for (const [name, input] of cases) {
    const output = sanitizeForTTS(input);
    const ok = output.length > 0 && output.length < input.length * 1.2;
    console.log(`[${ok ? 'OK' : 'WARN'}] ${name}`);
    console.log('  IN :', JSON.stringify(input));
    console.log('  OUT:', JSON.stringify(output));
    console.log();
    if (ok) passed++;
  }
  console.log(`通过 ${passed}/${cases.length} 用例`);
}
