/**
 * electron-builder.config.js — adaptive build configuration
 *
 * Why this file exists:
 *   The base `build` block in package.json hardcodes references to qwen-voice
 *   under $HOME/qwen-voice and HuggingFace model caches. Maintainers who have
 *   the full local voice stack get a "full" DMG (~5 GB). External users who
 *   `git clone` the repo do NOT have those paths — without this adaptive
 *   layer, electron-builder would fail at the resource-copy step.
 *
 *   This config file inherits everything from package.json#build, then
 *   rewrites `extraResources` to include voice assets ONLY if their source
 *   directories actually exist. The result:
 *     - Full host (you have ~/qwen-voice + HF cache) → full DMG, voice baked in
 *     - Fresh clone (no voice deps)                  → lite .app, voice off
 *
 *   Either path produces a working build. The lite build's PiOS.app launches
 *   normally; only NPC text-to-speech is unavailable (the app logs
 *   `[qwen-voice] not found in any candidate path — NPC voice disabled`).
 *
 *   To opt into the full bundle, install qwen-voice locally first
 *   (see docs/setup-qwen-voice.md).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const baseBuild = require('./package.json').build;
const home = os.homedir();

const extraResources = [];

// qwen-voice (Python venv + ref_voices + entrypoints)
const qwenVoiceDir = path.join(home, 'qwen-voice');
if (fs.existsSync(qwenVoiceDir)) {
  extraResources.push({
    from: qwenVoiceDir,
    to: 'qwen-voice',
    filter: [
      '**/*',
      '!**/*.bak-*',
      '!**/*.new',
      '!share/**',
      // Exclude any cloned voice samples that may live in a maintainer's local
      // qwen-voice install. Public builds must not ship private voice clones.
      '!ref_voices/owner.wav',
      '!ref_voices/feixia.wav',
      '!ref_voices/jupiter*.wav',
      '!ref_voices/pi.wav',
      '!ref_voices/xiaodou.wav',
    ],
  });
  console.log('[electron-builder] qwen-voice found → bundling voice stack');
} else {
  console.log(
    '[electron-builder] ~/qwen-voice not found — building lite (no NPC voice).'
  );
  console.log(
    '[electron-builder]   To bundle voice: install qwen-voice first '
      + '(see docs/setup-qwen-voice.md), then re-run.'
  );
}

// HuggingFace MLX model caches (~3 GB total when present)
const hfHubDir = path.join(home, '.cache', 'huggingface', 'hub');
const hfModels = [
  'models--mlx-community--whisper-large-v3-turbo',
  'models--mlx-community--Qwen3-TTS-12Hz-0.6B-CustomVoice-4bit',
  'models--mlx-community--Qwen3-TTS-12Hz-0.6B-Base-4bit',
];
let hfBundled = 0;
for (const modelDir of hfModels) {
  const src = path.join(hfHubDir, modelDir);
  if (fs.existsSync(src)) {
    extraResources.push({
      from: src,
      to: path.join('qwen-voice-models', 'hub', modelDir),
    });
    hfBundled++;
  }
}
if (hfBundled > 0) {
  console.log(
    `[electron-builder] ${hfBundled}/${hfModels.length} HuggingFace MLX models found → bundling`
  );
} else {
  console.log(
    '[electron-builder] No MLX model caches found — first launch will download '
      + '(~4-5 GB) on hosts that have qwen-voice running.'
  );
}

module.exports = {
  ...baseBuild,
  extraResources,
};
