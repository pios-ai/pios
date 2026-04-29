# Pi NPC · 化身皮肤系统

> bubble.html 的光球是 Pi 的本体/灵魂。NPC 是套在光球上的"外皮"。可插拔：默认关闭，Tray 菜单一键切换，卸载无残留。
>
> 当前内置皮肤：
> - **派大星（patrick）** — 粉色五角星，π 字样肚子；SVG 实现；thinking=右手抓头，working=双手敲击，talking=右手挥动 + 嘴一张一合。
> - **多啦A梦（doraemon）** — 蓝色圆头 + 白脸，红鼻 + 黄铃铛 + 白肚兜；SVG 实现；thinking=左手摸下巴，working=右手伸向肚兜口袋掏道具，recording=铃铛摇晃闪光，alert=冷汗 + 弹跳。
> - **大白（baymax）** — 白色棉花糖胶囊 + 两点黑眼 + 横线连接 + 胸口红心；SVG 实现（极简几何，容错高，契合 Pi AI 助手身份）；thinking=左手托胸，working=右手前伸扫描，recording=胸口红心跳动发光，talking=身体上下晃（无嘴故 bob 替代），alert=弹跳 + 冷汗。
> - **小黄人（minion）** — 黄色胶囊身 + 银护目镜（两圆+连接桥）+ 蓝背带裤 + 黑手脚 + 一根翘头发；SVG 实现；thinking=左手挠脑袋，working=右手抡锤 hammer 旋转，talking=嘴一张一合 + 右手挥，recording=胸口 Gru 徽章跳动发光，alert=弹跳 + 冷汗。
> - **卡比（kirby）** — 粉色圆球 + 红脚 + 脸颊红晕 + 竖眼；SVG 实现；thinking=左手托头，working=右手快速挥拳（kirby-punch），recording=胸前小金星 rotate + 放大发光，alert=弹跳 + 冷汗。
> - **龙猫（totoro）** — 灰色椭圆体 + 白肚子 + 三 V 斑纹 + 胡须 + 尖耳；SVG 实现（头顶绿叶作 bell）；thinking=左手托腮，working=右手轻拍肚（totoro-pat），recording=头顶叶子微摆 + 绿光晕，talking=嘴开合。
> - **史莱姆（slime）** — 蓝色水滴形 + 头顶高光 + 金色核心；SVG 实现（breathe 用 scaleY 做果冻挤压，无脚）；thinking=左手托下巴，working=右手戳戳（slime-poke），recording=金色核心 scale 放大 + 金光晕，tired=scaleY 0.75 整体塌陷。
> - **特朗普（trump）** — 橙色皮肤 + 金色 comb-over + 蓝西装 + 红领带 + MAGA 金胸针；SVG 实现；thinking=左手托腮，working=右手前伸做"指点"手势（trump-point），reflecting=双手抬起做"tremendous"小圆圈，recording=胸前 MAGA 金胸针 scale+金光晕（trump-maga），alert=弹跳+冷汗+头发 flap。
> - **星仔（starlet）** — 奶油米白大蛋头 + 蓝色针织毛线帽 + 金色小五角星 + 浅蓝肚兜；**Three.js 真 3D 实现**（首个异构皮肤，证明契约不限渲染方式）；working=帽上星星快转 + emissive 提亮，recording=星星变红脉动 + 身体震动，processing=头顶 3 个小球绕圈。
> - **小猪佩奇（peppa）** — 粉色侧面猪头 + 圆鼻子 + 红裙子 + 黑鞋；**GPT Image2 11-pose PNG 立绘实现**（idle / thinking / working / sensing / reflecting / talking / recording / processing / alert / tired / watching，rembg 去背 + 脚底对齐规范化；2026-04-26 从 SVG 重做）；talking=pose 图开合动画 + bob，working=专注 pose，alert=pop，tired=饱和度降低。
> - **超级飞侠（feixia）** — 蓝橙色圆润飞机机器人，白色驾驶舱脸、橙色机鼻和机翼、灰色起落架；**GPT Image2 11-pose PNG 立绘实现**（idle / thinking / working / sensing / reflecting / talking / recording / processing / alert / tired / watching）；talking=张嘴 + 挥手，说话动作可见。
> - **乔治（qiaozhi）** — 小猪佩奇之弟，正面胖圆脸 + 圆耳 + 大正面猪鼻（两鼻孔）+ 蓝色衬衫 + 蓝橙配色（红绿色盲友好）；SVG 实现；thinking=右手挠头，working=双手身前交替轻拍，talking=右手挥 + 嘴大开合，alert=整体大跳，delighted=双手举起轻跳。
> - **派（pi）** — Pi 本人专属 NPC，π 符号化身的圆润小精灵：蓝紫渐变身体 + 橙色 π 头冠 + 橙色发光瞳孔（蓝橙配色，owner 色盲友好）；SVG 实现；thinking=右手托腮，working=双手敲键盘，talking=右手挥 + 嘴开合，alert=整体跳 + π 冠闪烁，delighted=双手高举轻跳。
> - **小匠（xiaojiang）** — ImageDT 蓝色小蜜蜂原型，蓝色头罩 + IMAGEDT 白 T 恤 + 蓝白条纹身体 + 黑色蜜蜂尾；**GPT Image2 11-pose 栅格立绘实现**（PNG 切图，继承 pi-v2 呼吸/眨眼/talking 动画模板）；用"小豆温柔"音色 · 工匠语气（量化、严谨、不留半套）。
> - **竹宝（jubal）** — 从 Jubal Immich 人脸候选中选取 2025/2026 近脸照片作为参考，融合墨镜、蓝橙泳衣和海星记忆点；**GPT Image2 11-pose PNG 立绘实现**（idle / thinking / working / sensing / reflecting / talking / recording / processing / alert / tired / watching）；用"小豆温柔"音色，不做儿童声线克隆。
>
> 架构支持多皮肤并存，**渲染方式不限 SVG / 3D / Canvas2D / WebGL / PNG 立绘**——契约只约束 DOM 根节点 id、CSS scope、pose class 监听三件事，详见 [Skin 契约](#skin-契约皮肤扩展点) 段落。

## 开关

- **启用**：Tray → "NPC 模式"
- **切皮肤**：Tray → "NPC 皮肤" → 选一个（热切，不用重启，只换 body class）
- **状态持久化**：`Pi/State/pi-npc.json` (`{"enabled": true|false, "skin": "patrick", "x": N, "y": N}`)
- **窗口尺寸**：关=56×72，开=340×400（同一 BrowserWindow，启动时按状态直接建对应尺寸，避免先小后大导致 clamp 位置错位）
- **位置持久化**：拖动后 `x/y` 存入 `pi-npc.json`；下次启动 clamp 到当前屏 workArea 内
- **skin 缺省**：读不到 `skin` 字段或值不在可用清单里 → 回落 `patrick`（向后兼容老状态文件）

## Skin 契约（皮肤扩展点）

新皮肤只改 **renderer 的 CSS/DOM** 和 **一行 main.js 注册**，信号层（pi-pulse）、IPC、pose 词表、交互层全部不动。

### 1. 词表契约（pose vocabulary）

pi-pulse 推的 pose 名是 **skin-agnostic 的抽象状态**。每套皮肤必须覆盖这 11 个 pose（缺一个会静默降级为 `idle`）：

```
idle · thinking · working · sensing · reflecting
talking · recording · processing · alert · tired · watching
```

另外两个叠加 class（不是独立 pose，是可选增强）：`alert` 与 `talking` 可同时挂到容器；`tired` 可叠加在任何 pose 上做灰度效果。

### 2. CSS scope 约定

所有皮肤专属样式必须嵌在以下复合选择器下：

```css
body.npc-enabled.skin-<id> #npc-<id> { ... }
body.npc-enabled.skin-<id> #npc-<id>.<pose> { ... }
```

骨架层（`#pi` 光球、`#npc-head-toast` 气泡、`#npc-stream-bar` 意识流、`#status` 状态文字、`#npc-orbit` 卫星、`#npc-badge` 徽章）**不要**写在 `.skin-<id>` 下——这些是所有皮肤共用的基座。

### 3. DOM 契约

每个皮肤给自己一个唯一容器（**渲染方式不限**：SVG / Canvas2D / WebGL(Three.js) / 甚至 DOM 拼接都行；契约只管 id + CSS scope + class）：

```html
<!-- SVG 风格（派大星、多啦A梦） -->
<div id="npc-<id>">  <!-- 默认 display:none；仅 body.npc-enabled.skin-<id> 时显示 -->
  <svg>...</svg>
</div>

<!-- 3D 风格（星仔）：容器本身就是 canvas，Three.js 渲进去 -->
<canvas id="npc-<id>" width="96" height="96"></canvas>
```

容器默认 hidden 的基线规则挂在全局 `#npc-patrick, #npc-doraemon, #npc-starlet, #npc-head-toast, #npc-satellite { display: none; }` 这一行——新增皮肤时把 `#npc-<newid>` 加进这个列表。

**异构实现注意**：3D 或 Canvas 类皮肤的 pose 切换不走 CSS，而是 JS 监听自身 class 变化驱动场景状态。参考 `startStarlet` / `applyStarletPose`：在 `#npc-<id>` 上挂 `MutationObserver(attributes, class)`，变化时切 target 参数，渲染循环 lerp 当前 → target。渲染循环**只在 `skin-<id>` 激活时跑**，切走时 `cancelAnimationFrame` 暂停（省 GPU）。

### 4. 注册新皮肤（一共 4 步）

1. `renderer/bubble.html`
   - 在默认 hidden 基线里追加 `#npc-<newid>`
   - 新增 SVG / CSS 块（全部 scoped 在 `body.npc-enabled.skin-<newid>` 下）
   - 实现 11 个 pose 的视觉差分
2. `main.js`：`NPC_SKINS` 数组里 push 一项 `{ id: '<newid>', label: '<显示名>' }`
3. （可选）`pi-pulse.js`：如果新皮肤需要自己的信号（比如"吃饭"pose），在 pi-pulse 里加信号源，推 `{type:'state', primary:'eating'}`；所有皮肤共享这个 pose 词表
4. `docs/pi-npc.md`：在这一节追加新皮肤一句话描述

重启 PiOS，Tray → "NPC 皮肤" 选新皮肤，热切生效。

### 5. 几何参数（推荐约束，非强制）

当前光球 + 派大星的几何在 bubble.html 里写死：

- 窗口 340×400
- `#pi` 光球 `bottom: 44px`，48×48
- `#npc-patrick` `bottom: 52px`，96×96
- `#npc-head-toast` `bottom: 160px`
- `#npc-stream-bar` `bottom: 4px`，高 30px
- `#status` `bottom: 38px`

新皮肤如果尺寸差太多（比如 120×120 的叮当猫），在自己的 `body.skin-<id>` 作用域里覆盖 `#npc-<id>` 的位置/大小即可。骨架其他组件的位置不建议改——改了要重新调整气泡锚点、ticker 槽位、status 文本位置，工作量成倍增加。

## 音色映射（skin → voice）

启用 NPC 且皮肤命中下表时，PiOS TTS 自动换成角色克隆音色（在 `backend/qwen-tts.js` 的 `SKIN_VOICE_MAP`）：

| skin | voice | 类型 |
|---|---|---|
| doraemon | 多啦A梦 | 克隆（中文配音 ref，TTS→ASR 回环验证通过）|
| starlet | 星仔 | 克隆（中文童声 ref）|
| 其他 7 个 | 小豆温柔（DEFAULT_VOICE）| 兜底 |

**为什么其他 7 个暂时兜底**：自动搜索的 ref 素材多为多人对话/解说旁白/BGM 污染，克隆后跑 TTS→ASR 回环验证全部 fail（hit 7.2s 硬上限 + ASR 还原为"我 我 我"类垃圾）。等有高质量单人独白 ref 再加回来。

**添加新克隆音色的标准流程**：
1. 把 20-25s 单人连续说话、无 BGM 的 wav（24kHz mono）丢到 `$QWEN_HOME/ref_voices/<id>.wav`
2. 在 `$QWEN_HOME/app.py` 的 `CLONE_VOICES` 里加条目（`ref_text` 用 `/api/asr` 转录该 wav 拿到）
3. 重启服务：`launchctl kickstart -k gui/$UID/com.<owner>.qwen-voice`
4. **强制自验**：`curl -X POST /api/tts -d '{"text":"标准测试句","voice":"<新 ID>"}'` → 再 `/api/asr` 回读 → 对比原文；音频时长刚好 7.200000s 或 ASR 返回单字重复 = 克隆 fail，不要注册
5. 验证通过后在 [`backend/qwen-tts.js`](../backend/qwen-tts.js) 的 `SKIN_VOICE_MAP` 加一行 `<skin>: '<voice 名>'`，`npm run build`

优先级低于 `freeVoice + preset`（场景化显式选色仍优先）。

## 信号源 → 姿势映射

| 信号 | 来源 | 表现 |
|---|---|---|
| pi triage run | `Pi/State/runs/triage-*.json` | `thinking` 分派中 — 右手拉到下巴 |
| pi work run | `Pi/State/runs/work-*.json` | `working` 干活中 — 双手敲击 |
| pi sense-maker run | `Pi/State/runs/sense-maker-*.json` | `sensing` 对账中 — 右手放眉前远望 |
| pi reflect run | `Pi/State/runs/reflect-*.json` | `reflecting` 反思中 — 双手合十、眼睛眯 |
| F5 录音 | bubble 本地 `recording` | `recording` 在听 — 右手放耳边 |
| TTS 播放 | `tts:playback-state` IPC（AudioQueue 翻转） | `talking` 说话中 — 右手挥动 + 嘴巴一张一合 |
| notify level=critical | tail `Pi/Log/notify-history.jsonl` | `alert` 注意 — 整体弹跳 5s；若此时 TTS 开播，绑定到 TTS 结束（全程边跳边说）|
| `auth-pause.json` 存在 | `Pi/State/auth-pause.json` | `tired` 没电了 — 灰度 + 半透明 |
| 非 pi agent run | `Pi/State/runs/*.json` agent ≠ 'pi' | 卫星小球绕身公转 |
| 任意 notify-history 新 line | tail | 头顶 toast 气泡 5s（critical 7s） |
| Cards `needs_owner:` 数 | 扫 `Cards/active/*.md` | 右上角橙色徽章数字 |

## 优先级（pose 冲突时）

1. 本地 `recording` / `processing`（bubble 自己推，后台不能覆盖）
2. `alert talking` 叠加（critical 通知绑 TTS 期间，两个 class 同时挂到 `#npc-patrick`，整体跳 + 嘴动 + 右手挥同时生效）
3. `alert`（critical 通知 5s 内，TTS 未开播时）
4. `talking`（TTS 播放中，无 critical）
5. `tired`（auth-pause）
6. 最近 30s 内的 pi run pose
7. `idle`

**叠加态实现**：pi-pulse 推 `{type:'state', primary:'alert talking'}`，renderer 对 `primary` 空格分隔、每段查 `NPC_POSES` 白名单，合法 pose 拼接成 `pi.className`。`syncPatrickPose` 同步所有合法 pose 到 `#npc-patrick.className`，CSS 两条 `.alert` / `.talking` 规则作用在不同元素（container / .mouth / .hand-r）自然叠加。

**alert → TTS 绑定**：critical 通知落地时 `pi-pulse.alertBoundToTalking = true`；`setTalking(false)` 时解绑。未播 TTS 的 critical 维持原来的 5s 节奏，与 TTS 不耦合。

## 交互

| 点哪里 | 效果 |
|---|---|
| 派大星身体（`#npc-patrick`） | 立刻收气泡 + 打断 TTS（`bubble:interrupt-tts` IPC → 主进程 `AudioQueue.interrupt()`），**不**触发录音 |
| 头顶气泡（`#npc-head-toast`） | 同上 |
| 光球（`#pi`） | 切换录音（保持原行为） |
| 拖派大星 | 可以拖（和光球一样，3px 以内算点击，超过算拖动；`dragMoved` 标志防误触） |

## 气泡行为

- **宽度**：普通 toast `max-width: 310px`，speak 气泡 `max-width: 320px`（派大星头顶正上方锚定，尾巴朝下指进头顶）
- **高度**：`max-height: 200px` + `overflow-y: auto`，超长内容自动出滚动条（蓝色细条、鼠标可滚）
- **TTL**：按字数估算，`max(级别下限, chars*350 + 3000)` 上限 30s。级别下限 critical 12s / warning 10s / report 9s / reminder 8s / info 7s
- **级别色**：`.critical` 红橙、`.warning` 橙黄、`.report` 蓝、`.reminder` 绿、`.info` 默认蓝灰；注意 **TTS 走 speak 分支、不挂级别色**（避免 notify 彩色底开播后变白）

## 可插拔边界

所有改动都夹在 `NPC BEGIN/END` 注释块之间：

- [Projects/pios/backend/pi-pulse.js](../backend/pi-pulse.js) — 整个文件新增
- [Projects/pios/main.js](../main.js) — `// ── NPC BEGIN ──` 到 `// ── NPC END ──` 一段 + Tray 菜单两行条件项 + `ipcMain.on('tts:playback-state')` handler
- [Projects/pios/renderer/bubble.html](../renderer/bubble.html) — CSS / HTML / JS 三块 NPC BEGIN/END
- [Projects/pios/renderer/app.js](../renderer/app.js) — AudioQueue 两处 `window.pi?.ttsPlaybackState?.()`
- [Projects/pios/preload.js](../preload.js) — 一行 `ttsPlaybackState` 暴露

CSS 全部 scoped 在 `body.npc-enabled` 下。关闭时 `.npc-enabled` class 被移掉，派大星/toast/orbit/badge 全部 `display:none`，不占空间、不触发动画。

## 卸载（真要彻底拆）

```bash
# 1. 软卸载（保留代码，运行期关闭）
#    Tray → 取消"NPC 模式"   # 或：
echo '{"enabled": false, "skin": "patrick"}' > ~/PiOS/Pi/State/pi-npc.json

# 2. 硬卸载（删代码）
#    在 Projects/pios/ 下删以下 BEGIN/END 块：
#    - main.js:        // ── NPC BEGIN ──  到  // ── NPC END ──
#    - bubble.html:    /* ── NPC BEGIN ── */ / <!-- ── NPC BEGIN ── --> / // ── NPC BEGIN ──  三处
#    - app.js:         AudioQueue._playNext & interrupt 里的 window.pi?.ttsPlaybackState?.() 两行
#    - preload.js:     ttsPlaybackState: ... 一行
#    - backend/pi-pulse.js:  整个文件删
rm -f ~/PiOS/Pi/State/pi-npc.json
cd ~/PiOS/Projects/pios && npm run build
```

## 调试

- **Tray 循环 pose**：Tray → "🎭 下一个 pose (测试)"（每点一次切一种，3.5s 自动回 idle）
- **独立 DevTools**：Tray → "NPC DevTools (独立窗口)"（气泡窗太小 dock 进来看不清，用 detach 模式）
- **Console 手动切**：在独立 DevTools 里 `__npc('thinking')` / `__npc('alert')` / `__npc()`（重置）
- **Console 手动意识流**：`__stream({verb:'测试中', agent:'manual', card:'test-card'})`
- **触发 toast**：`bash ~/PiOS/Pi/Tools/notify.sh info "测试"` / `notify.sh critical "严重"`
- **触发 tired**：`touch ~/PiOS/Pi/State/auth-pause.json` → 恢复：`rm` 掉
- **触发卫星**：写个最小 run record：
  ```bash
  echo '{"plugin_name":"test","agent":"hawkeye","status":"running"}' \
    > ~/PiOS/Pi/State/runs/hawkeye-smoke.json
  ```
  30s 后自动衰减消失。

## 注意事项

- fs.watch 在 macOS 用 FSEvents，跨 Syncthing 同步过来的文件也会触发，不用额外 poll
- notify-history tail 只从启动时的文件末尾开始读，不重放历史（避免启动刷 toast）
- Cards 扫描节流 60s，避免 triage/work 批量改卡时 N 次 N×18 文件扫
- 派大星完全关闭时 pi-pulse 连 `start()` 都不调，零 IO / 零 timer 残留
- **renderer 改 bubble.html 时小心 TDZ**：`ipcRenderer.on` / `addEventListener` 挂载块必须在引用变量的 `const` 声明之后；任何一处引用早于声明会抛 ReferenceError，整个 script block 从那行起全 throw，后面所有 IPC handler 全部没注册（表象：派大星 / 头顶气泡失灵，但无明显错误）。排查先加 `window.addEventListener('error', ...)` + 主进程 `webContents.on('console-message')` 抓 console，再看动态时序
- **main.js 里 `NPC_SIZE_ON` / `NPC_SIZE_OFF` / `NPC_STATE_FILE` 必须在 `createBubbleWindow` 函数定义之前声明**：bubble 窗口在启动时立即创建并读这些常量，声明晚于引用会触发 TDZ，orb + Patrick 双双不显示
- **启动时 `npc:enable` IPC 兜底重发**：`bubbleWin.webContents.on('did-finish-load')` 里若 `npcEnabled=true` 再发一次，防早于 renderer `ipcRenderer.on` 注册被吞
