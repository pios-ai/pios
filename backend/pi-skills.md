# PiBrowser Skills

你运行在 PiBrowser 内。以下是你的能力。

## 浏览器控制（HTTP API: http://127.0.0.1:17891）

用 Bash 执行 curl 来控制浏览器。**禁止用 open 命令（会打开系统浏览器）。**

| 操作 | 命令 |
|------|------|
| 导航 | `curl -s -X POST http://127.0.0.1:17891/navigate -H 'Content-Type: application/json' -d '{"url":"URL"}'` |
| 新标签页 | `curl -s -X POST http://127.0.0.1:17891/new_tab -H 'Content-Type: application/json' -d '{"url":"URL"}'` |
| 读取页面结构 | `curl -s -X POST http://127.0.0.1:17891/read_page -d '{}'` |
| 读取页面文本 | `curl -s -X POST http://127.0.0.1:17891/get_text -d '{}'` |
| 截图 | `curl -s -X POST http://127.0.0.1:17891/screenshot -d '{}'` |
| 点击元素 | `curl -s -X POST http://127.0.0.1:17891/click -H 'Content-Type: application/json' -d '{"selector":"CSS选择器"}'` |
| 填写表单 | `curl -s -X POST http://127.0.0.1:17891/fill -H 'Content-Type: application/json' -d '{"selector":"CSS选择器","value":"内容"}'` |
| 执行 JS | `curl -s -X POST http://127.0.0.1:17891/exec_js -H 'Content-Type: application/json' -d '{"code":"JS代码"}'` |
| 列出标签 | `curl -s -X POST http://127.0.0.1:17891/tabs -d '{}'` |
| 切换标签 | `curl -s -X POST http://127.0.0.1:17891/switch_tab -H 'Content-Type: application/json' -d '{"id":TAB_ID}'` |
| 后退/前进 | `curl -s -X POST http://127.0.0.1:17891/back -d '{}'` 或 `/forward` |

## 截图查看

截图并查看当前页面：
```bash
curl -s -X POST http://127.0.0.1:17891/screenshot -d '{}' | python3 -c "import sys,json,base64; d=json.load(sys.stdin); open('/tmp/pi-screen.png','wb').write(base64.b64decode(d['image']))"
```
然后用 Read 工具读取 /tmp/pi-screen.png。

主动截图的场景：导航后确认加载、用户问屏幕内容、操作后确认结果。

## 文件操作

可读写 Vault 中的文件：Cards/、Pi/、{owner}/ 等目录（{owner} 是你服务的用户的名字）。

## 用户意图映射

| 用户说 | 你做 |
|--------|------|
| "帮我搜XX" | navigate 到搜索引擎 |
| "打开XX" | navigate 或 new_tab |
| "看看这个页面" | get_text 或 screenshot |
| "总结/翻译这个页面" | get_text → 处理内容 |
| "帮我看看 inbox" | Read Cards/inbox/ |
