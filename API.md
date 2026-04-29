# PiBrowser HTTP API

> 任何 Claude Code session 都可以通过 curl 控制 PiBrowser。
> 前提：PiBrowser 在 laptop-host 上运行着（端口 17891）。
> 登录态已持久化，不需要重新登录。

## 基础操作

```bash
# 导航到 URL
curl -s -X POST http://127.0.0.1:17891/navigate -H 'Content-Type: application/json' -d '{"url":"https://chatgpt.com"}'

# 新标签页打开
curl -s -X POST http://127.0.0.1:17891/new_tab -H 'Content-Type: application/json' -d '{"url":"https://chatgpt.com"}'

# 后退 / 前进
curl -s -X POST http://127.0.0.1:17891/back -d '{}'
curl -s -X POST http://127.0.0.1:17891/forward -d '{}'
```

## 页面读取

```bash
# 读取页面文本（纯文本）
curl -s -X POST http://127.0.0.1:17891/get_text -d '{}'

# 读取页面结构（HTML 骨架，用于拿 selector）
curl -s -X POST http://127.0.0.1:17891/read_page -d '{}'

# 截图（base64 PNG）
curl -s -X POST http://127.0.0.1:17891/screenshot -d '{}' | python3 -c "import sys,json,base64; d=json.load(sys.stdin); open('/tmp/pi-screen.png','wb').write(base64.b64decode(d['image']))"
# 然后 Read /tmp/pi-screen.png 查看
```

## 页面交互

```bash
# 点击元素
curl -s -X POST http://127.0.0.1:17891/click -H 'Content-Type: application/json' -d '{"selector":"#prompt-textarea"}'

# 填写输入框
curl -s -X POST http://127.0.0.1:17891/fill -H 'Content-Type: application/json' -d '{"selector":"#prompt-textarea","value":"你好"}'

# 执行任意 JS
curl -s -X POST http://127.0.0.1:17891/exec_js -H 'Content-Type: application/json' -d '{"code":"document.title"}'
```

## Tab 管理

```bash
# 列出所有标签页
curl -s -X POST http://127.0.0.1:17891/tabs -d '{}'

# 切换标签页
curl -s -X POST http://127.0.0.1:17891/switch_tab -H 'Content-Type: application/json' -d '{"id":1}'
```

## 典型流程：操作 ChatGPT

```bash
# 1. 打开 ChatGPT（已登录）
curl -s -X POST http://127.0.0.1:17891/navigate -H 'Content-Type: application/json' -d '{"url":"https://chatgpt.com"}'

# 2. 等页面加载
sleep 3

# 3. 截图确认页面状态
curl -s -X POST http://127.0.0.1:17891/screenshot -d '{}' | python3 -c "import sys,json,base64; d=json.load(sys.stdin); open('/tmp/pi-screen.png','wb').write(base64.b64decode(d['image']))"

# 4. 读取页面结构找到输入框 selector
curl -s -X POST http://127.0.0.1:17891/read_page -d '{}'

# 5. 填写并发送
curl -s -X POST http://127.0.0.1:17891/fill -H 'Content-Type: application/json' -d '{"selector":"#prompt-textarea","value":"帮我总结一下今天的新闻"}'
curl -s -X POST http://127.0.0.1:17891/exec_js -H 'Content-Type: application/json' -d '{"code":"document.querySelector(\"[data-testid=send-button]\").click()"}'

# 6. 等待回复后读取
sleep 10
curl -s -X POST http://127.0.0.1:17891/get_text -d '{}'
```

## 注意事项

- API 只在 laptop-host 本地可用（127.0.0.1）
- 如果返回 connection refused，说明 PiBrowser 没在运行
- 启动命令：`cd ~/PiOS/Projects/pios && npx electron . --dev &`
