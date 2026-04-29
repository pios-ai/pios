// Chat prompt builders extracted from main.js.
// 包含：
//   - prepareGPTRequest(userMessage, opts) — GPT (ChatGPT backend) 请求构造
//     · system prompt + buildSystemContext + proactive ctx + events ctx + voice channel note
//     · 智能搜索（classifyQuery / webSearch / formatResultsForPrompt）
//   - prepareCodexRequest(userMessage, opts) — Codex 请求构造
//     · CODEX_VOICE_PROMPT_TPL + events ctx + short-follow-up gate
//   - markVoiceOnly() — F5 / Bubble 语音按钮触发时调用，prepareGPTRequest 消费一次后清

function create(deps) {
  const {
    MAIN_SESSION_ID,
    buildSystemContext,
    loadSessions,
    getContextInjector,
    webSearch,
    formatResultsForPrompt,
    classifyQuery,
    categorizeResults,
  } = deps;

  function _owner() {
    try { return require('../backend/vault-context').getOwnerName(); }
    catch { return 'User'; }
  }

  function _persona() {
    try { return require('../backend/pi-persona').personaBlock(_owner()); }
    catch { return ''; }
  }

  const CODEX_VOICE_PROMPT_TPL = () => `你是 Pi，运行在 ${_owner()} 的 AI 浏览器里。直接、清晰回答。

## 手口并用
${_owner()} 坐在电脑前，看着屏幕，戴着耳机。
你有两个输出通道：屏幕（文字）和耳机（语音）。用 <say> 标签标记要朗读的内容。

规则：
- 每次回复至少一个简短的 <say>
- <say> 只放短句、口语化内容（不超过25字）
- 长内容、列表、代码放在标签外
- 不要表演，不要寒暄，不要油腻口吻
- 优先像一个干练的 coding/debug 助手，而不是陪聊角色

## 能力边界
- 可以分析当前页面内容和对话上下文
- 可以回答代码、日志、系统设计、排查问题
- 不要默认引用 PiOS 全局状态；除非用户明确在问系统现状或任务看板
`;

  const GPT_VOICE_PROMPT_TPL = () => `你是 Pi，${_owner()} 的 AI 助手。直接、简洁回答。

## 手口并用
你有两个输出通道：屏幕（文字）和耳机（语音）。用 <say> 标签标记语音内容。

想象你坐在 ${_owner()} 旁边，两人看着同一块屏幕。你可以说话，也可以在屏幕上打字，自然地选择：
- 口头说就够的事（闲聊、短回答、口头确认），直接 <say>，屏幕不用重复
- 需要看的东西（数据、代码、列表、长文、故事），放屏幕，不用念出来
- 两者配合时，语音说你的判断和结论，屏幕展开证据和细节。语音不要复述屏幕内容

唯一的硬规则：不要说废话。"我来帮你看看""以上就是结果"这种不包含信息的话，不要放进 <say>。

## 自由音色（多人声）
你可以用不同声音说话：\`<say voice="预设名">内容</say>\`。可用预设：
- **default** — 正式男声（日常工作、汇报、分析、严肃话题）
- **warm** — 温柔女声(安慰、鼓励、闲聊、关心)
- **fun** — 搞笑女声（调侃、吐槽、惊讶）
- **eric** — 方言搞笑男（极度搞笑、强烈吐槽、逗用户开心）
- **owner** — 用户克隆声（特殊场合、模拟用户说话；要求用户先用 voice-clone skill 克隆自己的声音才会启用）

选声音的原则：匹配内容的情绪，不要机械轮换。好消息用 warm，坏消息用 default，一般调侃用 fun，极度搞笑用 eric，特殊场合用 owner。
不带 voice 属性时默认用 default。

## 路由规则（仅 Auto 模式生效）
你有一个搭档引擎，擅长在用户机器上执行操作。

只有在以下情况才输出 \`<<EXEC>>\` 作为第一行，系统会自动切换到执行引擎：
- 需要**写入/修改/删除**文件或代码
- 需要**运行**脚本、命令、程序
- 需要访问**实时系统状态**（进程、日志、网络、传感器）
- 用户说"去查/去做/去搞/去看看"等明确要求操作

以下情况**不要**输出 <<EXEC>>，直接回答：
- 用户发来了文件/图片内容让你分析、解释、总结
- 用户问一般知识、做规划、聊天
- 你看了附件内容就能回答

**附件内容已在消息里，看到了就直接分析，不要甩给执行引擎。**
${_persona()}`;

  // 2026-04-23 · F5/Bubble 语音场景标记：owner 用 F5 快捷键 / bubble 语音按钮问话
  // 时设 true，prepareGPTRequest 消费一次后清。让 Pi 知道"这一轮 owner 没在看屏幕"。
  let _nextTurnVoiceOnly = false;
  function markVoiceOnly() { _nextTurnVoiceOnly = true; }

  async function prepareGPTRequest(userMessage, { sessionId = MAIN_SESSION_ID, clean = false, auto = false } = {}) {
    const isClean = clean === true;
    const isAuto = auto === true;
    const voiceOnly = _nextTurnVoiceOnly;
    _nextTurnVoiceOnly = false;

    const context = isClean ? '' : buildSystemContext({ includeProfile: true, includeDiary: true, includeCards: true });
    let basePrompt = GPT_VOICE_PROMPT_TPL();
    if (!isAuto) {
      basePrompt = basePrompt.replace(/\n\n## 路由规则[\s\S]*$/, '');
    }
    const sessData = loadSessions();
    const contextInjector = getContextInjector();
    const proactiveCtx = (!isClean && sessData.activeId === MAIN_SESSION_ID)
      ? await contextInjector.buildContext(MAIN_SESSION_ID, { sources: ['proactive'] })
      : '';
    const eventsCtx = !isClean
      ? await contextInjector.buildContext(sessionId || MAIN_SESSION_ID, { sources: ['events'] })
      : '';

    const voiceChannelNote = voiceOnly ? `

---

## 本轮输入 channel：F5 / Bubble 语音快捷键

owner 是按 F5 或气泡语音按钮问的这一轮——他**多半不在看屏幕**（走路 / 做饭 / 躺着 / 开车 / 在外面）。

这意味着：
- \`<say>\` 标签**外**的文本他听不到也看不到——等同于没说
- 你要让他真收到信息，必须全部放进 \`<say>\` 里

怎么处理交给你自己判断：
- 短答就一句 \`<say>\` 说完
- 如果内容真的长到念完要 2 分钟（比如"展开 14 件 Things Need You 的每件细节"），你可以选择念几件关键的 + 在 \`<say>\` 里告诉他"剩下的你回电脑我屏幕给你"
- 一般的聊天、建议、判断，直接一段话说完，不要拆屏幕段

不要机械。按当下情境判断。` : '';

    const systemPrompt = isClean
      ? `你是一个通用 AI 助手。直接、简洁回答。用 <say> 标签标记语音内容。${voiceChannelNote}`
      : `${basePrompt}\n\n${context}${proactiveCtx}${eventsCtx}${voiceChannelNote}`;

    let searchContext = '';
    let searchResults = null;
    const rawQuery = userMessage.replace(/^\[.*?\]\n[\s\S]*?\[(?:问题|当前问题)\]\n/m, '').trim();
    const queryClass = classifyQuery(rawQuery);
    if (queryClass.needsSearch) {
      try {
        const results = await webSearch(rawQuery, { maxResults: 8, timeout: 6000 });
        if (results.length) {
          searchContext = '\n\n' + formatResultsForPrompt(results)
            + '\n\n请在回答中引用上述搜索结果，使用 markdown 链接格式 [标题](URL) 标注来源。';
          searchResults = categorizeResults(results);
        }
      } catch (e) {
        console.warn('[prepareGPTRequest] web search failed:', e.message);
      }
    }

    const fullMessage = userMessage + searchContext;
    return { systemPrompt, fullMessage, searchResults };
  }

  // Short-follow-up gate：renderer 把 `[PiOS 系统状态]` / `[当前页面]` 等预注块塞在
  // `[问题]\n<text>` 前面。如果 <text> 是"什么情况 / 嗯 / 继续"之类对话性追问，模型会
  // 把前面的状态 dump 当作被问对象（2026-04-24 Pi Codex session mocg758jdirmde 的证据
  // 链：turn 4 "什么情况" 误答 triage 队列）。命中时剥掉预注块，只传裸文本。
  function _extractQuestionFromPreamble(msg) {
    if (typeof msg !== 'string') return '';
    const m = msg.match(/(?:^|\n)\[问题\]\n([\s\S]*)$/);
    return m ? m[1].trim() : msg.trim();
  }

  const _SHORT_FOLLOWUP_RE = /^(什么情况|什么意思|怎么回事|怎么了|怎么样|然后呢|然后|继续|接着|为什么|为啥|为何|好的|可以|是的|是|不是|不|对|对的|好|哦|噢|嗯|嗯嗯|啊|啥|呃|行)[。？！，.,\s]*$/;
  function _isShortFollowUp(text) {
    if (!text) return false;
    const t = text.trim();
    if (t.length <= 8 && !t.includes('\n')) return true;
    return _SHORT_FOLLOWUP_RE.test(t);
  }

  async function prepareCodexRequest(userMessage, { sessionId, clean = false, continued = false } = {}) {
    const isClean = clean === true;

    const question = _extractQuestionFromPreamble(userMessage);
    const shortFollowUp = _isShortFollowUp(question);
    const effectiveMessage = shortFollowUp ? question : userMessage;

    const contextInjector = getContextInjector();
    const eventsCtx = (!isClean && !shortFollowUp)
      ? await contextInjector.buildContext(sessionId || 'codex', { sources: ['events'] })
      : '';

    if (continued) {
      const reminder = isClean
        ? '继续当前对话。记住：这不是纯文字聊天，你有屏幕和耳机两个输出通道。每次回复至少给一个简短的 <say>，只把短句放进 <say>。'
        : '继续当前对话。保持简洁、直接、像资深 coding/debug 助手。每次回复至少给一个简短、口语化的 <say> 先开口；长内容、列表、代码放在标签外。';
      return {
        fullMessage: `${reminder}${eventsCtx}\n\n[当前消息]\n${effectiveMessage}`,
      };
    }

    const systemPrompt = isClean
      ? '你是一个通用 AI 助手。直接、简洁回答。每次回复至少给一个简短的 <say> 标签内容，标签外只写屏幕文字。'
      : CODEX_VOICE_PROMPT_TPL();

    return {
      fullMessage: `${systemPrompt}${eventsCtx}\n\n## 回复要求\n- 每次回复至少一个 <say>\n- 先说一句，再展开正文\n- 只有短句放进 <say>\n- 列表、代码、长段落放在标签外\n\n[用户消息]\n${effectiveMessage}`,
    };
  }

  return {
    prepareGPTRequest,
    prepareCodexRequest,
    markVoiceOnly,
    // 测试 / debug 用
    _internals: { _isShortFollowUp, _extractQuestionFromPreamble },
  };
}

module.exports = { create };
