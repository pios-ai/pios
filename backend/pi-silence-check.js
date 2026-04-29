/**
 * pi-silence-check.js
 * Phase 1: 沉默检测，读 pi-social.json 的 last_interaction_at，
 * 计算 silence_hours，写入 silence_detected / silence_hours / silence_level / silence_since_ts。
 * Phase 1 只静默写入，不触发任何通知。
 * 被 triage 动作 7.5 末尾调用。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./lib/atomic-write');

const VAULT = process.env.PIOS_VAULT || path.join(process.env.HOME, 'PiOS');
const SOCIAL_PATH = path.join(VAULT, 'Pi/State/pi-social.json');

function run() {
  let social;
  try {
    social = JSON.parse(fs.readFileSync(SOCIAL_PATH, 'utf8'));
  } catch (e) {
    console.error('[silence-check] 读 pi-social.json 失败:', e.message);
    process.exit(0); // 非致命，静默退出
  }

  const lastInteractionAt = social.last_interaction_at;
  if (!lastInteractionAt) {
    // 无交互记录，跳过
    console.log('[silence-check] no last_interaction_at, skip');
    process.exit(0);
  }

  const nowMs = Date.now();
  const lastMs = new Date(lastInteractionAt).getTime();
  if (isNaN(lastMs)) {
    console.error('[silence-check] last_interaction_at 格式无效:', lastInteractionAt);
    process.exit(0);
  }

  const silenceHours = (nowMs - lastMs) / 3600000;

  let silenceLevel = null;
  let silenceDetected = false;

  if (silenceHours >= 36) {
    silenceLevel = 'deep';
    silenceDetected = true;
  } else if (silenceHours >= 12) {
    silenceLevel = 'medium';
    silenceDetected = true;
  } else if (silenceHours >= 4) {
    silenceLevel = 'light';
    silenceDetected = true;
  }

  social.silence_detected = silenceDetected;
  social.silence_hours = Math.round(silenceHours * 10) / 10;
  social.silence_level = silenceLevel;
  social.silence_since_ts = silenceDetected ? lastInteractionAt : null;

  writeJsonAtomic(SOCIAL_PATH, social);

  console.log(`[silence-check] silence_detected=${silenceDetected} hours=${social.silence_hours} level=${silenceLevel}`);
}

run();
