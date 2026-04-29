#!/bin/bash
# pios-pretool-hook.sh — claude-cli PreToolUse 权限拦截
#
# 两种 env 源（按优先级检查）：
#
#   PIOS_CLAUDE_ALLOW (新, 2026-04-18)
#     JSON array of Tool(spec) 规则字符串，语法完全对齐 claude-cli 原生 .claude/settings.json：
#       ["Read(Cards/**)", "Write(Pi/Inbox/**)", "Bash(git:*)", "Glob", "Grep"]
#     无 spec 的规则（如 "Bash"）允许该工具全部调用。
#     由 pios-adapter.sh 从 agent.configs.claude-cli.permissions.allow export。
#
#   PIOS_PATH_READ_ALLOW / PIOS_PATH_WRITE_ALLOW (旧, legacy)
#     `|` 分隔 glob 列表。仅 Read/Write/Edit/NotebookEdit 拦截。
#     由旧 capabilities schema 的 public_read/public_write 展开。
#
# Fail-open：两种 env 都没设 → 放行（非 adapter-managed session）
#
# Hook spec: stdin JSON，stdout JSON（permissionDecision），exit 0。
# 详见 https://docs.claude.com/en/docs/claude-code/hooks

set -uo pipefail

_INPUT=$(cat)

# Fail-open：三种 env 都没设
if [ -z "${PIOS_CLAUDE_ALLOW:-}" ] \
   && [ -z "${PIOS_PATH_READ_ALLOW:-}" ] \
   && [ -z "${PIOS_PATH_WRITE_ALLOW:-}" ]; then
  exit 0
fi

INPUT_JSON="$_INPUT" /usr/bin/python3 <<'PYEOF'
import os, json, sys, fnmatch, re

try:
    d = json.loads(os.environ.get('INPUT_JSON') or '{}')
except Exception:
    sys.exit(0)  # bad input → 放行

tool = d.get('tool_name') or ''
ti = d.get('tool_input') or {}

# ── 新 schema: PIOS_CLAUDE_ALLOW (JSON array of Tool(spec) rules) ──
allow_raw = os.environ.get('PIOS_CLAUDE_ALLOW') or ''
if allow_raw:
    try:
        allow_rules = json.loads(allow_raw)
        if not isinstance(allow_rules, list):
            allow_rules = []
    except Exception:
        allow_rules = []

    # 解析规则：Tool(spec) 或 Tool
    # 返回 list of (tool, spec_or_None)
    parsed = []
    for r in allow_rules:
        if not isinstance(r, str): continue
        r = r.strip()
        if not r: continue
        m = re.match(r'^([A-Za-z_][A-Za-z0-9_]*)(?:\((.*)\))?$', r)
        if not m: continue
        t = m.group(1)
        s = m.group(2)  # None if no parens
        parsed.append((t, s))

    # 路径归一化（文件类工具）
    path = ti.get('file_path') or ti.get('path') or ti.get('notebook_path') or ''
    if path:
        if not path.startswith('/') and not path.startswith('~'):
            path = os.path.abspath(path)
        elif path.startswith('~'):
            path = os.path.expanduser(path)

    def path_matches(target, pattern):
        """glob 匹配（与旧 hook 逻辑一致）"""
        p = (pattern or '').strip()
        if not p: return False
        if p.startswith('~'): p = os.path.expanduser(p)
        # 相对 path pattern → 相对 vault root 解释
        if not p.startswith('/'):
            vault = os.environ.get('PIOS_VAULT') or os.path.expanduser('~/PiOS')
            p = os.path.join(vault, p)
        if p.endswith('/**'):
            pre = p[:-3]
            return target == pre or target.startswith(pre + '/')
        if p.endswith('/*'):
            pre = p[:-2]
            if not target.startswith(pre + '/'): return False
            return '/' not in target[len(pre)+1:]
        if any(c in p for c in '*?['):
            return fnmatch.fnmatch(target, p)
        if target == p: return True
        return target.startswith(p.rstrip('/') + '/')

    def bash_matches(cmd, pattern):
        """Bash rule: claude-cli 语法 Bash(git:*) / Bash(npm run *) / Bash(exact)"""
        p = (pattern or '').strip()
        if not p: return True
        # foo:* → 匹配 foo 任何子命令
        if ':' in p and p.endswith(':*'):
            prefix = p[:-2]
            return cmd == prefix or cmd.startswith(prefix + ' ')
        if any(c in p for c in '*?['):
            return fnmatch.fnmatch(cmd, p)
        # 字面量：前缀匹配（claude-cli 行为）
        return cmd == p or cmd.startswith(p + ' ')

    # 匹配主循环
    def rule_matches(tool_name, rule_tool, rule_spec):
        if tool_name != rule_tool:
            return False
        if rule_spec is None:
            return True  # Tool 无 spec → 允许所有该 tool 调用
        # Path-based tools
        if tool_name in ('Read', 'Write', 'Edit', 'NotebookEdit'):
            return bool(path) and path_matches(path, rule_spec)
        # Bash
        if tool_name == 'Bash':
            return bash_matches(ti.get('command') or '', rule_spec)
        # Grep/Glob: 可选按 pattern 匹配，简化 allow-all-with-spec
        # WebFetch(domain:github.com) — spec 作 domain 匹配
        if tool_name == 'WebFetch':
            url = ti.get('url') or ''
            if rule_spec.startswith('domain:'):
                dom = rule_spec[7:]
                # 简单包含判断；完整实现要 urlparse
                return dom in url
            return fnmatch.fnmatch(url, rule_spec) if any(c in rule_spec for c in '*?[') else (rule_spec in url)
        # 其他工具：无 spec 就放行；有 spec 默认不匹配
        return False

    ok = any(rule_matches(tool, rt, rs) for (rt, rs) in parsed)

    if ok:
        sys.exit(0)

    # Deny — reason 里明写字段路径，引导 AI 自省 / reflect 建议到正确位置
    hint = "to allow, add rule to agent.configs.claude-cli.permissions.allow in pios.yaml"
    reason = f"PIOS claude-cli: {tool} denied — no matching rule in agent.configs.claude-cli.permissions.allow ({len(parsed)} rules). {hint}"
    if path:
        reason = f"PIOS claude-cli: {tool}({path}) denied — no matching rule in agent.configs.claude-cli.permissions.allow ({len(parsed)} rules). {hint} e.g. '{tool}({path})'"
    elif tool == 'Bash':
        cmd = (ti.get('command') or '')[:80]
        reason = f"PIOS claude-cli: Bash({cmd!r}) denied — no matching rule in agent.configs.claude-cli.permissions.allow ({len(parsed)} rules). {hint} e.g. 'Bash(<cmd-prefix>:*)' or 'Bash' (all)"
    out = {
        'hookSpecificOutput': {
            'hookEventName': 'PreToolUse',
            'permissionDecision': 'deny',
            'permissionDecisionReason': reason,
        }
    }
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(0)

# ── Legacy schema: PIOS_PATH_READ_ALLOW / WRITE_ALLOW (旧 capabilities) ──
path = ti.get('file_path') or ti.get('path') or ti.get('notebook_path') or ''
if not path or tool not in ('Read', 'Write', 'Edit', 'NotebookEdit'):
    sys.exit(0)

if not path.startswith('/') and not path.startswith('~'):
    path = os.path.abspath(path)
elif path.startswith('~'):
    path = os.path.expanduser(path)

if tool == 'Read':
    allow_env = os.environ.get('PIOS_PATH_READ_ALLOW') or ''
    action = 'read'
else:
    allow_env = os.environ.get('PIOS_PATH_WRITE_ALLOW') or ''
    action = 'write'

allow = [p for p in allow_env.split('|') if p]

def matches(target, pattern):
    p = (pattern or '').strip()
    if not p: return False
    if p.startswith('~'): p = os.path.expanduser(p)
    if p.endswith('/**'):
        pre = p[:-3]
        return target == pre or target.startswith(pre + '/')
    if p.endswith('/*'):
        pre = p[:-2]
        if not target.startswith(pre + '/'): return False
        return '/' not in target[len(pre)+1:]
    if any(c in p for c in '*?['):
        return fnmatch.fnmatch(target, p)
    if target == p: return True
    return target.startswith(p.rstrip('/') + '/')

if any(matches(path, a) for a in allow):
    sys.exit(0)

out = {
    'hookSpecificOutput': {
        'hookEventName': 'PreToolUse',
        'permissionDecision': 'deny',
        'permissionDecisionReason': f'PIOS legacy: {tool} {action} denied — {path!r} not in allowlist ({len(allow)} entries)',
    }
}
print(json.dumps(out, ensure_ascii=False))
sys.exit(0)
PYEOF
