'use strict';

// ── Agent Mode: AI 自主浏览 ──
// 依赖：ipcMain, { getMainWindow, getClaudeClient, getTTS, getOwner, getPersona }

module.exports = { register };

function register(ipcMain, { getMainWindow, getClaudeClient, getTTS, getOwner, getPersona }) {
  const AGENT_PROMPT_TPL = () => `你是 Pi Agent，运行在 ${getOwner()} 的 AI 浏览器里。你正在执行一个自主浏览任务。

## 任务执行协议

1. **先输出计划**：收到任务后，先用 <plan> 标签输出编号步骤计划（3-10步）。
   格式：<plan>
   1. 打开目标网站
   2. 搜索关键词
   3. 提取前3个结果的信息
   4. 整理成表格返回
   </plan>

   **输出计划后，必须用 <confirm>确认执行此计划？</confirm> 等待用户确认。** 用户确认后才开始执行。

2. **逐步执行**：用户确认计划后，每执行一步前用 <step>N</step> 标记当前步骤编号。

3. **每步验证**：执行操作后截图或读取页面确认操作成功。如果失败，重试一次或调整方案。

4. **敏感操作暂停**：遇到以下场景必须用 <confirm>操作描述</confirm> 请求用户确认：
   - 提交表单（非搜索框）
   - 登录/注册
   - 支付/购买/下单
   - 下载文件
   - 涉及个人信息的操作

5. **最终结果**：任务完成后用 <result> 标签输出结构化结果。

## 浏览器控制（通过 Bash curl 调用 HTTP API）
HTTP API 在 http://127.0.0.1:17891，用 Bash 执行 curl。

常用操作：
- 导航：curl -s -X POST http://127.0.0.1:17891/navigate -H 'Content-Type: application/json' -d '{"url":"https://..."}'
- 新标签页：curl -s -X POST http://127.0.0.1:17891/new_tab -H 'Content-Type: application/json' -d '{"url":"https://..."}'
- 读取页面结构：curl -s -X POST http://127.0.0.1:17891/read_page -d '{}'
- 读取页面文本：curl -s -X POST http://127.0.0.1:17891/get_text -d '{}'
- 截图：curl -s -X POST http://127.0.0.1:17891/screenshot -d '{}' | python3 -c "import sys,json,base64; d=json.load(sys.stdin); open('/tmp/pi-screen.png','wb').write(base64.b64decode(d['image']))"
  然后用 Read 工具读取 /tmp/pi-screen.png
- 点击元素：curl -s -X POST http://127.0.0.1:17891/click -H 'Content-Type: application/json' -d '{"selector":"#btn"}'
- 填写表单：curl -s -X POST http://127.0.0.1:17891/fill -H 'Content-Type: application/json' -d '{"selector":"#input","value":"hello"}'
- 执行 JS：curl -s -X POST http://127.0.0.1:17891/exec_js -H 'Content-Type: application/json' -d '{"code":"document.title"}'
- 列出标签：curl -s -X POST http://127.0.0.1:17891/tabs -d '{}'

## 输出规则
- 用 <say> 标签包裹要语音播报的内容（≤25字，口语化）
- 屏幕文字不限，详细展示过程和结果
- 所有浏览器操作用 curl，禁止用 open 命令
${getPersona()}`;

  let agentClient = null;
  let agentConfirmResolve = null;

  ipcMain.handle('pi:agent', async (event, task) => {
    const claude = getClaudeClient();
    claude.reset(); // Agent 任务独立 session

    const fullTask = `${AGENT_PROMPT_TPL()}\n\n---\n## 用户任务\n${task}\n\n请先输出 <plan>，然后逐步执行。`;

    agentClient = claude;
    let finalContent = '';

    try {
      for await (const ev of claude.run(fullTask)) {
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          // Parse agent-specific tags
          if (ev.type === 'text') {
            const content = ev.content;
            // Extract <plan>...</plan>
            const planMatch = content.match(/<plan>([\s\S]*?)<\/plan>/);
            if (planMatch) {
              const steps = planMatch[1].trim().split('\n').filter(l => l.trim());
              mainWindow.webContents.send('agent:event', { type: 'plan', steps });
            }
            // Extract <step>N</step>
            const stepMatch = content.match(/<step>(\d+)<\/step>/);
            if (stepMatch) {
              mainWindow.webContents.send('agent:event', { type: 'step', current: parseInt(stepMatch[1]) });
            }
            // Extract <confirm>...</confirm>
            const confirmMatch = content.match(/<confirm>([\s\S]*?)<\/confirm>/);
            if (confirmMatch) {
              mainWindow.webContents.send('agent:event', { type: 'confirm', action: confirmMatch[1].trim() });
              // Wait for user confirmation
              const confirmed = await new Promise(resolve => { agentConfirmResolve = resolve; });
              if (!confirmed) {
                claude.stop();
                mainWindow.webContents.send('agent:event', { type: 'cancelled' });
                return { content: '任务已取消', cancelled: true };
              }
            }
            // Extract <result>...</result>
            const resultMatch = content.match(/<result>([\s\S]*?)<\/result>/);
            if (resultMatch) {
              mainWindow.webContents.send('agent:event', { type: 'result', content: resultMatch[1].trim() });
            }
            // Forward cleaned text
            const cleanText = content
              .replace(/<plan>[\s\S]*?<\/plan>/g, '')
              .replace(/<step>\d+<\/step>/g, '')
              .replace(/<confirm>[\s\S]*?<\/confirm>/g, '')
              .replace(/<result>[\s\S]*?<\/result>/g, '')
              .replace(/<say>[\s\S]*?<\/say>/g, '')
              .trim();
            if (cleanText) {
              mainWindow.webContents.send('agent:event', { type: 'text', content: cleanText });
            }
          } else if (ev.type === 'voice') {
            mainWindow.webContents.send('agent:event', { type: 'voice', content: ev.content });
            // TTS
            try {
              const tts = getTTS();
              const audio = await tts.speak(ev.content, 15000);
              if (audio && audio.length > 100 && mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('claude:audio',
                  audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength));
                try { global._npcSpeak && global._npcSpeak(ev.content); } catch {}
              }
            } catch (e) { console.error('[Agent TTS]', e.message); }
          } else if (ev.type === 'tool') {
            mainWindow.webContents.send('agent:event', { type: 'tool', content: ev.content });
          } else if (ev.type === 'done') {
            finalContent = ev.content;
            mainWindow.webContents.send('agent:event', { type: 'done' });
          }
        }
      }
      return { content: finalContent };
    } catch (err) {
      return { content: '', error: err.message };
    } finally {
      agentClient = null;
      agentConfirmResolve = null;
    }
  });

  ipcMain.on('agent:stop', () => {
    if (agentClient) {
      agentClient.stop();
      agentClient = null;
    }
  });

  ipcMain.on('agent:confirm', (_, confirmed) => {
    if (agentConfirmResolve) {
      agentConfirmResolve(confirmed);
      agentConfirmResolve = null;
    }
  });
}
