'use strict';
const path = require('path');
const fs = require('fs');

// Electron shell for opening browser URLs (auth login flow).
// Loaded lazily so this module can be required in unit-test contexts too.
let _shell = null;
function getShell() {
  if (!_shell) {
    try { _shell = require('electron').shell; } catch {}
  }
  return _shell;
}

/**
 * Auth-related GET endpoints — call from inside the GET block.
 * Returns true if the endpoint was handled, false otherwise.
 */
function handleGet(endpoint, url, s, res, jsonHeaders) {
  const VAULT_ROOT = s.VAULT_ROOT;

  if (endpoint === '/pios/auth-status') {
    // New per-host model: read Pi/Log/auth-status-*.json (each host writes its own),
    // plus probe remote hosts that haven't written one yet via SSH.
    // Returns:
    //   {
    //     updated_at: <latest>,
    //     hosts: {
    //       laptop-host:    { updated_at, engines: {claude-cli: {ok, detail, login_supported}, ...}},
    //       worker-host: { updated_at, engines: {...}}
    //     },
    //     // Backward-compat flat "engines" key: merged view with the *worst* state per engine
    //     engines: { "claude-cli": {ok, detail}, ... }
    //   }
    const logDir = path.join(VAULT_ROOT, 'Pi', 'Log');
    const hosts = {};
    let latestTs = null;

    // 1. Read all per-host files
    try {
      for (const f of fs.readdirSync(logDir)) {
        const m = f.match(/^auth-status-([a-z0-9_-]+)\.json$/i);
        if (!m) continue;
        try {
          const data = JSON.parse(fs.readFileSync(path.join(logDir, f), 'utf8'));
          const hostName = data.host || m[1];
          hosts[hostName] = data;
          if (data.updated_at && (!latestTs || data.updated_at > latestTs)) latestTs = data.updated_at;
        } catch {}
      }
    } catch {}

    // 2. For any host registered in pios.yaml but missing from per-host files,
    //    derive its state from **adapter run records** (Pi/State/runs/*.json).
    //    This is a ZERO-cost probe — we read files that adapter already writes
    //    as a side-effect of running tasks. No SSH, no API calls, no tokens.
    //    Run records are Syncthing-shared so laptop-host can see worker-host's records.
    try {
      const yaml = require('js-yaml');
      const manifest = yaml.load(fs.readFileSync(path.join(VAULT_ROOT, 'Pi', 'Config', 'pios.yaml'), 'utf-8'));
      const instances = (manifest && manifest.infra && manifest.infra.instances) || {};
      const allAgents = (manifest && manifest.agents) || {};
      // Only infer for hosts that are actually targets of a claude-cli agent
      // or task. Storage/relay nodes (storage-host, vpn-host) have no AI engines
      // and should not appear in the auth UI at all.
      const hostsWithClaudeCli = new Set();
      for (const agent of Object.values(allAgents)) {
        if (agent.runtime !== 'claude-cli') continue;
        const agentHosts = Array.isArray(agent.hosts) ? agent.hosts : (agent.host ? [agent.host] : []);
        for (const h of agentHosts) if (h) hostsWithClaudeCli.add(h);
        for (const task of Object.values(agent.tasks || {})) {
          const taskHosts = Array.isArray(task.hosts) ? task.hosts : (task.host ? [task.host] : []);
          for (const h of taskHosts) if (h) hostsWithClaudeCli.add(h);
        }
      }
      // Target hosts = pios.yaml instances that (a) have no auth-status file yet
      // AND (b) are actually used by a claude-cli agent
      const missing = Object.keys(instances).filter(h => !hosts[h] && hostsWithClaudeCli.has(h));
      if (missing.length) {
        // Build an index: { host: { runtime: latestRun } } by scanning recent run records.
        const runsDir = path.join(VAULT_ROOT, 'Pi', 'State', 'runs');
        const recentByHostRuntime = {};  // host -> runtime -> latest run record
        try {
          const files = fs.readdirSync(runsDir);
          // Only look at runs from the past 24 hours (by filename date) to keep this fast
          const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
          const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10).replace(/-/g, '');
          const recent = files.filter(f => f.includes(today) || f.includes(yesterday));
          for (const fname of recent) {
            try {
              const rec = JSON.parse(fs.readFileSync(path.join(runsDir, fname), 'utf8'));
              const h = rec.host;
              const rt = rec.runtime || rec.requested_runtime;
              if (!h || !rt) continue;
              const startedAt = rec.started_at || rec.finished_at;
              if (!recentByHostRuntime[h]) recentByHostRuntime[h] = {};
              const existing = recentByHostRuntime[h][rt];
              if (!existing || (startedAt && startedAt > (existing.started_at || ''))) {
                recentByHostRuntime[h][rt] = rec;
              }
            } catch {}
          }
        } catch {}

        // Honest classification: failed = failed (don't pretend ok from a failure).
        // ok:   last run succeeded
        // fail: last run failed (any reason — auth, quota, runtime-error, tool error, whatever)
        // null: no recent runs
        const classifyRun = (rec) => {
          if (!rec) return { ok: null, detail: 'no recent runs' };
          const succeeded = rec.status === 'success' || rec.status === 'ok' || rec.exit_code === 0;
          if (succeeded) {
            return { ok: true, detail: `last run ok (${rec.agent || rec.run_id || '?'})` };
          }
          const reason = rec.fallback_reason || `exit ${rec.exit_code != null ? rec.exit_code : '?'}`;
          return { ok: false, detail: `last run failed — ${reason}` };
        };

        for (const host of missing) {
          const runtimes = recentByHostRuntime[host] || {};
          const engines = {};
          // For each runtime we've seen recent runs on, classify it
          for (const [rt, rec] of Object.entries(runtimes)) {
            const c = classifyRun(rec);
            if (c.ok === null) continue;
            engines[rt] = {
              ok: c.ok,
              detail: c.detail,
              login_supported: rt === 'claude-cli',
            };
          }
          // If no runs recorded for claude-cli on this host, still show a row
          // so user can explicitly Login. Mark as "unknown (no recent runs)".
          if (!engines['claude-cli']) {
            engines['claude-cli'] = {
              ok: null,  // tri-state: null = unknown
              detail: 'no recent runs on this host',
              login_supported: true,
            };
          }
          hosts[host] = {
            host,
            updated_at: new Date().toISOString(),
            engines,
            probe_method: 'run-records',
          };
        }
      }
    } catch {}

    // 3. Flat merged "engines" view for backward compat — worst status wins.
    const mergedEngines = {};
    for (const [hostName, hostData] of Object.entries(hosts)) {
      const engines = (hostData && hostData.engines) || {};
      for (const [ename, einfo] of Object.entries(engines)) {
        if (!mergedEngines[ename]) {
          mergedEngines[ename] = { ...einfo };
        } else if (mergedEngines[ename].ok && einfo && einfo.ok === false) {
          // Downgrade to the failing state
          mergedEngines[ename] = { ...einfo, detail: `${hostName}: ${einfo.detail}` };
        }
      }
    }

    const result = {
      updated_at: latestTs,
      hosts,
      engines: mergedEngines,  // backward compat
    };
    res.writeHead(200, jsonHeaders);
    res.end(JSON.stringify(result));
    return true;
  }

  // ── GET: Auth login session status (polling) ──
  if (endpoint === '/pios/auth/login/status') {
    const sessionId = url.searchParams.get('id');
    const session = s._loginSessions.get(sessionId);
    if (!session) {
      res.writeHead(404, jsonHeaders);
      res.end(JSON.stringify({ error: 'not_found', id: sessionId }));
      return true;
    }
    res.writeHead(200, jsonHeaders);
    res.end(JSON.stringify({
      id: sessionId,
      host: session.host,
      state: session.state,
      url: session.url,
      email: session.email,
      exitCode: session.exitCode,
      elapsed: Math.floor((Date.now() - session.startedAt) / 1000),
      lines: session.lines.slice(-30),
      error: session.error || null,
    }));
    return true;
  }

  return false;
}

/**
 * Auth-related POST endpoints — call after parsing request body.
 * Returns true if the endpoint was handled, false otherwise.
 */
function handlePost(endpoint, params, s, res, jsonHeaders) {
  const VAULT_ROOT = s.VAULT_ROOT;

  // ── POST: 一键重新探活 auth-based runtime ──
  // 跑 auth-manager.sh check + auth-check.sh，两个脚本都会按实时结果写回 pios.yaml。
  // 用在 quota 提前恢复 / 外部登录后系统没察觉的场景。
  // 返回：{ ok, engine, runtime_status, active_account, output }
  if (endpoint === '/pios/auth-refresh') {
    // 探活 — real liveness probe for claude-cli on a specific host.
    //
    //   host absent / host is local → run local auth-manager.sh check + auth-check.sh
    //     (refreshes Keychain harvest + codex file check + rewrites auth-status-laptop-host.json)
    //
    //   host is a remote instance (has ssh field) → SSH and run `claude auth status`
    //     there, parse loggedIn, write auth-status-<host>.json. This is the ONLY
    //     way to know if a remote host's credentials still work.
    try {
      const { engine, host } = params;
      const vault = VAULT_ROOT;
      const yaml = require('js-yaml');
      const manifest = yaml.load(fs.readFileSync(path.join(vault, 'Pi', 'Config', 'pios.yaml'), 'utf-8'));
      const instances = (manifest?.infra?.instances) || {};
      const inst = host ? instances[host] : null;
      const localHostname = require('os').hostname().toLowerCase();
      const isRemote = inst && inst.ssh && !localHostname.startsWith(host);

      if (isRemote) {
        // Real remote probe: SSH probe differs by engine
        const { spawn } = require('child_process');
        const probeEngine = engine || 'claude-cli';
        const probeCmd = probeEngine === 'codex-cli'
          // codex-cli: check ~/.codex/auth.json exists and has access_token
          ? `python3 -c "
import json, os, sys
try:
    d = json.load(open(os.path.expanduser('~/.codex/auth.json')))
    t = d.get('tokens', {}).get('access_token', '')
    lr = d.get('last_refresh', '')
    print('ok|' + lr if t else 'no_token|')
except FileNotFoundError:
    print('not_found|')
except Exception as e:
    print('error|' + str(e))
" 2>&1 || echo PROBE_FAILED`
          // claude-cli: run claude auth status
          : 'export PATH=$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin; claude auth status 2>&1 || echo PROBE_FAILED';
        const ssh = spawn('ssh', ['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes', inst.ssh, probeCmd]);
        let stdout = '', stderr = '';
        ssh.stdout.on('data', d => stdout += d.toString());
        ssh.stderr.on('data', d => stderr += d.toString());
        ssh.on('close', (code) => {
          const combined = (stdout + '\n' + stderr).trim();
          let loggedIn = false, detail = 'probe failed';
          try {
            if (probeEngine === 'codex-cli') {
              // Output format: "ok|<last_refresh>" or "no_token|" or "not_found|" or "error|..."
              const line = combined.trim().split('\n').find(l => l.includes('|')) || '';
              const [status, extra] = line.split('|');
              if (status === 'ok') {
                loggedIn = true;
                const hoursAgo = extra ? (() => {
                  try {
                    const ms = Date.now() - new Date(extra).getTime();
                    return Math.round(ms / 3600000);
                  } catch { return null; }
                })() : null;
                detail = hoursAgo != null ? `ok (refreshed ${hoursAgo}h ago)` : 'ok';
              } else if (status === 'no_token') {
                detail = 'no access_token in auth.json';
              } else if (status === 'not_found') {
                detail = 'auth.json not found on remote';
              } else if (combined.includes('PROBE_FAILED')) {
                detail = 'python3 not found or errored on remote';
              } else {
                detail = extra || combined.slice(0, 200) || 'unknown error';
              }
            } else {
              // claude auth status emits JSON on stdout when successful
              const jsonMatch = combined.match(/\{[\s\S]*\}/);
              if (jsonMatch) {
                const j = JSON.parse(jsonMatch[0]);
                loggedIn = j.loggedIn === true;
                detail = loggedIn
                  ? `ok (authMethod=${j.authMethod || '?'}, subscription=${j.subscriptionType || '?'})`
                  : 'not logged in';
              } else if (combined.includes('PROBE_FAILED')) {
                detail = 'claude CLI not found or errored on remote';
              } else {
                detail = combined.slice(0, 200) || 'empty response';
              }
            }
          } catch (e) {
            detail = 'parse error: ' + e.message;
          }
          // Write per-host auth status file
          try {
            const logDir = path.join(vault, 'Pi', 'Log');
            const file = path.join(logDir, `auth-status-${host}.json`);
            let existing = {};
            try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
            const engines = existing.engines || {};
            engines[probeEngine] = {
              ok: loggedIn,
              detail,
              login_supported: true,
            };
            fs.mkdirSync(logDir, { recursive: true });
            fs.writeFileSync(file, JSON.stringify({
              host,
              updated_at: new Date().toISOString(),
              engines,
              probe_method: 'ssh-live-probe',
            }, null, 2));
          } catch (e) {
            res.writeHead(500, jsonHeaders);
            res.end(JSON.stringify({ ok: false, error: 'failed to write auth-status file: ' + e.message }));
            return;
          }
          res.writeHead(200, jsonHeaders);
          res.end(JSON.stringify({
            ok: loggedIn,
            host,
            engine: probeEngine,
            runtime_status: loggedIn ? 'ok' : 'down',
            detail,
            output: combined.slice(0, 500),
          }));
        });
        ssh.on('error', (e) => {
          res.writeHead(500, jsonHeaders);
          res.end(JSON.stringify({ ok: false, error: 'ssh spawn error: ' + e.message }));
        });
        return true;
      }

      // Local probe: keep the existing auth-manager + auth-check flow
      const { exec } = require('child_process');
      const cmd = `bash "${vault}/Pi/Tools/auth-manager.sh" check 2>&1; bash "${vault}/Pi/Tools/auth-check.sh" 2>&1`;
      exec(cmd, { timeout: 30000, env: { ...process.env, PIOS_VAULT: vault } }, (err, stdout, stderr) => {
        const output = ((stdout || '') + (stderr || '')).trim();
        const tail = output.split('\n').slice(-8).join('\n');
        try {
          const pios = yaml.load(fs.readFileSync(path.join(vault, 'Pi', 'Config', 'pios.yaml'), 'utf-8'));
          const runtimes = pios?.infra?.runtimes || {};
          const rtFor = (id) => runtimes[id] || {};
          const summary = engine
            ? { engine, runtime_status: rtFor(engine).status || 'unknown', error: rtFor(engine).error || null, active_account: rtFor(engine).active_account || null }
            : { engines: Object.fromEntries(Object.entries(runtimes).map(([k,v]) => [k, { status: v.status, error: v.error }])) };
          res.writeHead(200, jsonHeaders);
          res.end(JSON.stringify({ ok: engine ? (rtFor(engine).status === 'ok') : true, ...summary, output: tail }));
        } catch (e) {
          res.writeHead(500, jsonHeaders);
          res.end(JSON.stringify({ ok: false, error: e.message, output: tail }));
        }
      });
    } catch (e) {
      res.writeHead(500, jsonHeaders); res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return true;
  }

  // ── POST: Auth Login (claude-cli / codex-cli) ──
  // Body: { engine, host }. 总在 laptop-host 本地 spawn `claude/codex auth login`
  // (node-pty 真 TTY 给 Ink)，成功后读 token 本地 + SSH 推到所有远端。
  // 前端 poll /pios/auth/login/status 拿 sessionId 状态。
  if (endpoint === '/pios/auth/login') {
    try {
      const engine = params.engine || 'claude-cli';
      const host = params.host || require('../backend/host-helper').resolveHost();
      if (engine !== 'claude-cli' && engine !== 'codex-cli') {
        res.writeHead(400, jsonHeaders);
        res.end(JSON.stringify({ ok: false, error: `engine '${engine}' login not supported (supported: claude-cli, codex-cli)` }));
        return true;
      }
      // claude-cli: OAuth JSON from macOS Keychain → ~/.claude/.credentials.json
      // codex-cli:  ~/.codex/auth.json on remotes
      const yaml = require('js-yaml');
      const manifest = yaml.load(fs.readFileSync(path.join(VAULT_ROOT, 'Pi', 'Config', 'pios.yaml'), 'utf-8'));
      const instances = (manifest && manifest.infra && manifest.infra.instances) || {};
      const agents = (manifest && manifest.agents) || {};
      const localHostname = require('os').hostname().toLowerCase();

      // Figure out our own canonical instance name (the one matching this hostname)
      let localInstanceName = null;
      for (const [name, inst] of Object.entries(instances)) {
        if (localHostname.startsWith(name)) { localInstanceName = name; break; }
      }
      if (!localInstanceName) localInstanceName = require('../backend/host-helper').resolveHost();  // fallback

      // Collect remote hosts that need credentials for this engine.
      // claude-cli: derive from agents (agents with runtime=claude-cli) —
      //   not every SSH host runs claude-cli agents.
      // codex-cli and others: sync to ALL SSH-accessible instances —
      //   codex is a system tool; no agents are defined with runtime=codex-cli.
      const syncTargetHosts = new Set();
      if (engine === 'claude-cli') {
        for (const agent of Object.values(agents)) {
          if (agent.runtime !== 'claude-cli') continue;
          const agentHosts = Array.isArray(agent.hosts) ? [...agent.hosts] : (agent.host ? [agent.host] : []);
          for (const task of Object.values(agent.tasks || {})) {
            const taskHosts = Array.isArray(task.hosts) ? task.hosts : (task.host ? [task.host] : []);
            for (const h of taskHosts) agentHosts.push(h);
          }
          for (const h of agentHosts) {
            if (!h || h === localInstanceName) continue;
            const inst = instances[h];
            if (inst && inst.ssh) syncTargetHosts.add(h);
          }
        }
      } else {
        // For codex-cli and other tools: sync to all SSH-accessible instances
        for (const [name, inst] of Object.entries(instances)) {
          if (!inst.ssh || name === localInstanceName) continue;
          syncTargetHosts.add(name);
        }
      }
      const syncTargets = [...syncTargetHosts].map(h => ({ host: h, ssh: instances[h].ssh }));

      // Original host from UI click is only used for display ("you clicked X's
      // Login button, here's what happened"). The actual login always runs local.
      const clickedHost = host;

      const pty = require('node-pty');
      const loginCmd = engine === 'claude-cli'
        ? 'claude auth logout 2>&1 || true; claude auth login'
        : 'codex login';
      const child = pty.spawn('bash', ['-lc', loginCmd], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}`, TERM: 'xterm-256color' },
      });

      const sessionId = require('crypto').randomUUID();
      const session = {
        id: sessionId,
        engine,
        host: localInstanceName,   // the host we actually run on
        clickedHost,               // the host the user clicked (for UI display)
        syncTargets,               // [{host, ssh}, ...]
        isLocal: true,             // always
        proc: child,
        startedAt: Date.now(),
        state: 'starting',         // starting → await_auth → syncing → done | failed
        lines: [],
        url: null,
        email: null,
        exitCode: null,
        error: null,
      };
      s._loginSessions.set(sessionId, session);
      session.lines.push(`[pios] running ${engine} login on ${localInstanceName} (local)`);
      if (clickedHost !== localInstanceName) {
        session.lines.push(`[pios] will sync credentials to ${clickedHost} after login completes`);
      }
      if (syncTargets.length > 0) {
        session.lines.push(`[pios] sync targets: ${syncTargets.map(t => t.host).join(', ')}`);
      }

      // Helper: open browser exactly once
      const openBrowser = (reason) => {
        if (session._browserOpened) return;
        session._browserOpened = true;
        try {
          getShell().openExternal(session.url);
          session.lines.push(`[pios] opened authorization URL in your default browser (${reason})`);
        } catch (e) {
          session.lines.push(`[pios] failed to open URL: ${e.message}`);
        }
      };

      const processChunk = (chunk) => {
        const text = chunk.toString();
        session._buf = (session._buf || '') + text;
        for (const raw of text.split(/\r?\n/)) {
          const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim();
          if (line) session.lines.push(line);
        }

        // Find the auth URL and open it. For local login the browser hits the
        // ephemeral localhost callback on this same machine — no port extraction,
        // no tunnel, no stdin paste needed. The CLI exits 0 when the browser
        // flow completes; we sync credentials in onExit.
        if (!session.url) {
          const flat = session._buf
            .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
            .replace(/\x1b\][^\x07]*\x07/g, '')
            .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
            .replace(/\s+/g, '');
          const urlMatch = flat.match(/https?:\/\/[^\s'"`)]+/);
          if (urlMatch) {
            session.url = urlMatch[0];
            session.state = 'await_auth';
            openBrowser('local');
          }
        }

        const successMatch = text.match(/Logged in as ([^\s]+)|Successfully logged in|Login successful/i);
        if (successMatch) {
          session.email = successMatch[1] || session.email;
        }
      };

      child.onData(processChunk);

      // Helper: read fresh token JSON after login succeeds (engine-specific source)
      const readLocalToken = () => {
        if (engine === 'claude-cli') {
          try {
            const out = require('child_process')
              .execSync('security find-generic-password -s "Claude Code-credentials" -w', { encoding: 'utf8', timeout: 5000 })
              .trim();
            JSON.parse(out);  // validate
            return out;
          } catch (e) {
            session.lines.push(`[pios] ERROR reading Keychain: ${e.message}`);
            return null;
          }
        } else {
          // codex-cli: read ~/.codex/auth.json directly
          try {
            const tokenPath = path.join(require('os').homedir(), '.codex', 'auth.json');
            const out = fs.readFileSync(tokenPath, 'utf8').trim();
            JSON.parse(out);  // validate
            return out;
          } catch (e) {
            session.lines.push(`[pios] ERROR reading ~/.codex/auth.json: ${e.message}`);
            return null;
          }
        }
      };

      // Helper: push OAuth JSON to a remote host's ~/.claude/.credentials.json
      const syncToRemote = (target, oauthJson) => {
        return new Promise((resolve) => {
          const b64 = Buffer.from(oauthJson).toString('base64');
          // Single SSH command: write file via base64 decode, chmod, then confirm
          const remoteScript = engine === 'claude-cli'
            ? [
                'set -e',
                'mkdir -p ~/.claude',
                `echo '${b64}' | base64 -d > ~/.claude/.credentials.json.tmp`,
                'mv ~/.claude/.credentials.json.tmp ~/.claude/.credentials.json',
                'chmod 600 ~/.claude/.credentials.json',
                'echo SYNC_OK',
              ].join(' && ')
            : [
                'set -e',
                // 1. Write ~/.codex/auth.json
                'mkdir -p ~/.codex',
                `echo '${b64}' | base64 -d > ~/.codex/auth.json.tmp`,
                'mv ~/.codex/auth.json.tmp ~/.codex/auth.json',
                'chmod 600 ~/.codex/auth.json',
                // 2. Update openclaw agent auth-profiles.json (best-effort, || true so set -e is not triggered)
                `python3 -c "
import json,glob,os,tempfile,sys
try:
  c=json.load(open(os.path.expanduser('~/.codex/auth.json')))
  t=c.get('tokens',{});a=t.get('access_token','');r=t.get('refresh_token','')
  if not a: sys.exit(0)
  for f in glob.glob(os.path.expanduser('~/.openclaw/agents/*/agent/auth-profiles.json')):
    try:
      d=json.load(open(f));changed=False
      for k,p in d.get('profiles',{}).items():
        if 'openai-codex' in k:
          p['access']=a
          if r: p['refresh']=r
          changed=True
      if changed:
        fd,tmp=tempfile.mkstemp(dir=os.path.dirname(f))
        with os.fdopen(fd,'w') as out: json.dump(d,out,indent=2)
        os.replace(tmp,f)
    except Exception as e: print('warn:'+f+':'+str(e),file=sys.stderr)
except Exception as e: print('warn:openclaw:'+str(e),file=sys.stderr)
" || true`,
                // 3. Restart openclaw gateway (best-effort)
                'systemctl --user restart openclaw-gateway.service 2>/dev/null || true',
                'echo SYNC_OK',
              ].join(' && ');
          const ssh = require('child_process').spawn('ssh', [
            '-o', 'StrictHostKeyChecking=no',
            '-o', 'ConnectTimeout=10',
            '-o', 'BatchMode=yes',
            target.ssh,
            remoteScript,
          ]);
          let stdout = '', stderr = '';
          ssh.stdout.on('data', d => stdout += d.toString());
          ssh.stderr.on('data', d => stderr += d.toString());
          ssh.on('close', (code) => {
            if (code === 0 && stdout.includes('SYNC_OK')) {
              session.lines.push(`[pios] ✅ synced credentials to ${target.host}`);
              resolve(true);
            } else {
              session.lines.push(`[pios] ❌ sync to ${target.host} failed (exit ${code}): ${(stderr || stdout).slice(0, 200)}`);
              resolve(false);
            }
          });
          ssh.on('error', (e) => {
            session.lines.push(`[pios] ❌ sync to ${target.host}: ssh spawn error: ${e.message}`);
            resolve(false);
          });
        });
      };

      // Helper: write/merge Pi/Log/auth-status-<host>.json for a remote host
      // after a successful sync. This is the HIGHER-priority data source that
      // UI /pios/auth-status reads first (Step 1 in that endpoint) — without
      // this, UI falls through to inferring state from task run records, which
      // can be stale (e.g. "last run failed — quota" from hours ago).
      const writeRemoteAuthStatus = (hostName) => {
        try {
          const logDir = path.join(VAULT_ROOT, 'Pi', 'Log');
          const file = path.join(logDir, `auth-status-${hostName}.json`);
          let existing = {};
          try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
          const engines = existing.engines || {};
          engines[engine] = {
            ok: true,
            detail: `synced from ${localInstanceName} at ${new Date().toISOString()}`,
            login_supported: true,
          };
          const data = {
            host: hostName,
            updated_at: new Date().toISOString(),
            engines,
            probe_method: 'credential-sync',
          };
          fs.mkdirSync(logDir, { recursive: true });
          fs.writeFileSync(file, JSON.stringify(data, null, 2));
          session.lines.push(`[pios] wrote auth-status-${hostName}.json (ok)`);
        } catch (e) {
          session.lines.push(`[pios] warning: failed to write auth-status-${hostName}.json: ${e.message}`);
        }
      };

      // Helper: update local auth-status-<localInstanceName>.json after login succeeds.
      // For claude-cli: runs `claude auth status` to extract email/authMethod.
      // For codex-cli: marks ok with timestamp.
      // Never throws — best-effort UI update only.
      const writeLocalAuthStatus = () => {
        try {
          const logDir = path.join(VAULT_ROOT, 'Pi', 'Log');
          const file = path.join(logDir, `auth-status-${localInstanceName}.json`);
          let existing = {};
          try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
          const engines = existing.engines || {};

          if (engine === 'claude-cli') {
            // Run claude auth status to get actual email + authMethod
            try {
              const out = require('child_process').execSync(
                'claude auth status 2>&1',
                { encoding: 'utf8', timeout: 8000,
                  env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}` } }
              );
              const jsonMatch = out.match(/\{[\s\S]*\}/);
              if (jsonMatch) {
                const j = JSON.parse(jsonMatch[0]);
                if (j.loggedIn) {
                  const parts = [`authMethod=${j.authMethod || 'claude.ai'}`];
                  if (j.emailAddress || session.email) parts.push(`email=${j.emailAddress || session.email}`);
                  if (j.subscriptionType) parts.push(`subscription=${j.subscriptionType}`);
                  engines['claude-cli'] = { ok: true, detail: `ok (${parts.join(', ')})`, login_supported: true };
                  session.lines.push(`[pios] local auth-status updated: ${parts.join(', ')}`);
                }
              }
            } catch (e) {
              session.lines.push(`[pios] note: claude auth status check skipped (${e.message.slice(0, 60)})`);
            }
          } else {
            // codex-cli: just mark ok
            engines['codex-cli'] = { ok: true, detail: `ok (logged in at ${new Date().toISOString()})`, login_supported: true };
          }

          fs.mkdirSync(logDir, { recursive: true });
          fs.writeFileSync(file, JSON.stringify({
            ...existing,
            host: localInstanceName,
            updated_at: new Date().toISOString(),
            engines,
          }, null, 2));
        } catch (e) {
          session.lines.push(`[pios] warning: could not write local auth-status: ${e.message}`);
        }
      };

      // On login success: update local auth-status, then fan out credentials to remote hosts.
      const syncCredentialsToAllTargets = async () => {
        session.state = 'syncing';

        // Step 1: always update local auth-status (captures email for UI display)
        writeLocalAuthStatus();

        if (session.syncTargets.length === 0) {
          session.lines.push('[pios] no remote hosts need credential sync');
          return;
        }
        session.lines.push(`[pios] reading fresh ${engine} token…`);
        const oauthJson = readLocalToken();
        if (!oauthJson) {
          session.state = 'failed';
          session.error = engine === 'claude-cli'
            ? 'could not read Keychain after login (is `security` accessible?)'
            : 'could not read ~/.codex/auth.json after login';
          return;
        }
        session.lines.push(`[pios] token obtained (${oauthJson.length} bytes)`);
        const results = await Promise.all(session.syncTargets.map(t => syncToRemote(t, oauthJson)));
        // For each host that synced successfully, mark its auth-status file
        // as ok so the UI stops showing stale "last run failed" inference.
        session.syncTargets.forEach((t, i) => {
          if (results[i]) writeRemoteAuthStatus(t.host);
        });
        const okCount = results.filter(Boolean).length;
        const total = results.length;
        if (okCount === total) {
          session.lines.push(`[pios] ✅ all ${total} remote host(s) synced`);
        } else {
          session.lines.push(`[pios] ⚠️  ${okCount}/${total} remote host(s) synced — see errors above`);
        }
      };

      child.onExit(({ exitCode, signal }) => {
        session.exitCode = exitCode;
        if (exitCode === 0) {
          // Login succeeded locally. Fire off the sync; onExit itself doesn't
          // wait, but the UI state stays 'syncing' until syncCredentialsToAllTargets resolves.
          (async () => {
            try {
              await syncCredentialsToAllTargets();
              if (session.state !== 'failed') {
                session.state = 'done';
              }
            } catch (e) {
              session.state = 'failed';
              session.error = 'sync error: ' + e.message;
              session.lines.push(`[pios] ERROR during sync: ${e.message}`);
            }
          })();
        } else {
          session.state = 'failed';
          if (!session.error) session.error = `${engine} login exited with code ${exitCode}${signal ? ' (signal ' + signal + ')' : ''}`;
        }
      });

      // 5-min timeout safety: if still waiting for auth after 5 min, mark failed.
      setTimeout(() => {
        if (session.state !== 'done' && session.state !== 'failed' && session.state !== 'syncing') {
          try { child.kill(); } catch {}
          session.state = 'failed';
          session.error = 'timeout (5 min) waiting for OAuth callback';
          session.lines.push('[pios] timed out waiting for browser authorization');
        }
      }, 5 * 60 * 1000);

      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify({
        ok: true,
        sessionId,
        engine,
        host: localInstanceName,
        clickedHost,
        syncTargets: syncTargets.map(t => t.host),
      }));
    } catch (e) {
      res.writeHead(500, jsonHeaders);
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return true;
  }

  // ── POST: Cancel an in-progress login session ──
  if (endpoint === '/pios/auth/login/cancel') {
    const sessionId = params.sessionId || params.id;
    const session = s._loginSessions.get(sessionId);
    if (!session) {
      res.writeHead(404, jsonHeaders);
      res.end(JSON.stringify({ ok: false, error: 'not_found' }));
      return true;
    }
    try { session.proc.kill(); } catch {}
    session.state = 'failed';
    session.error = session.error || 'cancelled by user';
    res.writeHead(200, jsonHeaders);
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  return false;
}

module.exports = { handleGet, handlePost };
