/**
 * atomic-write.js — single source of truth for atomic file writes in PiOS.
 *
 * Why this file exists:
 *   PiOS state files live in a Syncthing-synced vault and are written by
 *   multiple processes across multiple machines (PiOS.app main process,
 *   cron-driven adapters, sub-processes spawned by the scheduler). A naive
 *   `fs.writeFileSync(path, content)` can be observed mid-write by another
 *   process or by Syncthing's filewatcher, which causes:
 *     - Other machines pulling a half-written file (truncated JSON)
 *     - Triage / sense-maker reading partial state and making wrong
 *       decisions, then committing those decisions over the still-being-
 *       written file → cross-session "lost update" bugs
 *
 *   The fix is the standard tmp+rename atomic write pattern: write content
 *   to a temp file, then `rename(tmp, target)`. POSIX `rename(2)` is atomic
 *   on the same filesystem — readers see either the old file or the new
 *   file, never a half-written one.
 *
 *   This pattern was previously open-coded in ~12 places (profile.js,
 *   pi-greet.js, pi-speak.js, wechat-aggregator.js, pios-engine.js x8,
 *   etc.). Centralizing it here lets future code do `require('./lib/atomic-
 *   write')` instead of recopying.
 *
 * Usage:
 *   const { writeAtomic, writeJsonAtomic, appendJsonl } = require('./lib/atomic-write');
 *
 *   writeAtomic('/path/file.txt', 'content');
 *   writeJsonAtomic('/path/state.json', { foo: 1 });
 *
 *   // For JSONL log files where each line is a complete record, append
 *   // is naturally atomic at the OS level; this helper just adds a mkdir
 *   // and a JSON.stringify so callers don't repeat boilerplate.
 *   appendJsonl('/path/log.jsonl', { ts: Date.now(), msg: 'hello' });
 *
 * Concurrency note:
 *   tmp filename includes pid + nanosecond timestamp so concurrent writers
 *   on the same target don't collide on tmp. Whichever rename runs last wins
 *   the target — that's the standard "last writer wins" semantic. If you
 *   need stronger semantics (compare-and-swap, locks), use Pi/State/locks/
 *   via pios-tick.sh's try_acquire_lock instead.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function _mkdirp(filePath) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch { /* parent dir already exists */ }
}

function _tmpName(target) {
  // pid + hrtime ns gives enough entropy that two concurrent writes from
  // the same process at the same wall-clock millisecond won't collide.
  const ns = process.hrtime.bigint().toString();
  return `${target}.tmp.${process.pid}.${ns}`;
}

/**
 * Atomic write of a string or Buffer.
 *
 * @param {string} target - absolute path to write
 * @param {string|Buffer} content
 * @param {object} [opts]
 * @param {string} [opts.encoding='utf8'] - ignored if content is Buffer
 * @param {number} [opts.mode] - file mode passed to writeFileSync
 */
function writeAtomic(target, content, opts = {}) {
  _mkdirp(target);
  const tmp = _tmpName(target);
  const writeOpts = {};
  if (typeof content === 'string') writeOpts.encoding = opts.encoding || 'utf8';
  if (opts.mode !== undefined) writeOpts.mode = opts.mode;
  try {
    fs.writeFileSync(tmp, content, writeOpts);
    fs.renameSync(tmp, target);
  } catch (err) {
    // Best-effort cleanup; if rename failed, tmp may still exist.
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

/**
 * Atomic write of a JSON object. Adds trailing newline by convention.
 *
 * @param {string} target
 * @param {object|Array} obj
 * @param {object} [opts] - same as writeAtomic, plus { indent: 2 } default
 */
function writeJsonAtomic(target, obj, opts = {}) {
  const indent = opts.indent === undefined ? 2 : opts.indent;
  const text = JSON.stringify(obj, null, indent) + '\n';
  writeAtomic(target, text, opts);
}

/**
 * Append one JSONL record. mkdirp parent. Append is naturally atomic at the
 * OS write(2) level for short writes, so no tmp+rename needed.
 *
 * @param {string} target
 * @param {object} record
 */
function appendJsonl(target, record) {
  _mkdirp(target);
  fs.appendFileSync(target, JSON.stringify(record) + '\n', { flag: 'a' });
}

module.exports = { writeAtomic, writeJsonAtomic, appendJsonl };
