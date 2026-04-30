'use strict';

/**
 * CLI bridge for cron/background callers of Pi/Tools/notify.sh.
 * It reads one JSON payload from stdin and dispatches through pi-speak without
 * requiring the Electron main process queue watcher to be running.
 */

async function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  raw = raw.trim();
  if (!raw) throw new Error('empty payload');

  const obj = JSON.parse(raw);
  if (!obj || !obj.text) throw new Error('payload.text is required');

  const piSpeak = require('./pi-speak');
  let result;
  if (obj.type === 'intent') {
    result = piSpeak.proposeIntent({
      source: obj.source || 'notify.sh',
      level: obj.level || 'info',
      text: obj.text,
      priority: obj.priority || 3,
      expires_at: obj.expires_at || null,
    });
  } else {
    result = await piSpeak.fireReflex({
      source: obj.source || 'notify.sh',
      level: obj.level || 'info',
      text: obj.text,
      expires_at: obj.expires_at || null,
      ts: obj.ts || null,
      eventId: obj.event_id || null,
    });
  }

  process.stdout.write(JSON.stringify({ ok: true, result }) + '\n');
}

main().catch((err) => {
  process.stderr.write(`[pi-speak-dispatch] ${err.message}\n`);
  process.exit(1);
});
