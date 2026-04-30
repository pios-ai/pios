/**
 * 火山引擎 WebSocket 流式 TTS — Node.js 版
 * 移植自 xiaoqi/volc_ws_tts.py
 */

const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const WS_URL = 'wss://openspeech.bytedance.com/api/v1/tts/ws_binary';

class VolcStreamTTS {
  constructor({ appid, token, voice = 'zh_female_shuangkuaisisi_moon_bigtts', speedRatio = 1.2 }) {
    this.appid = appid;
    this.token = token;
    this.voice = voice;
    this.speedRatio = speedRatio;
    this._ws = null;
    this._busy = false;
  }

  _buildRequest(text) {
    const payload = {
      app: { appid: this.appid, token: this.token, cluster: 'volcano_tts' },
      user: { uid: 'pios' },
      audio: { voice_type: this.voice, encoding: 'mp3', speed_ratio: this.speedRatio },
      request: { reqid: uuidv4(), text, operation: 'submit' },
    };
    const body = Buffer.from(JSON.stringify(payload), 'utf-8');
    const header = Buffer.from([0x11, 0x10, 0x10, 0x00]);
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(body.length);
    return Buffer.concat([header, lenBuf, body]);
  }

  async _ensureConnected() {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      try {
        this._ws.ping();
        return;
      } catch {
        this._ws = null;
      }
    }
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL, {
        headers: { Authorization: `Bearer;${this.token}` },
      });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('WS connect timeout'));
      }, 5000);
      ws.on('open', () => {
        clearTimeout(timer);
        this._ws = ws;
        resolve();
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /**
   * 全量 TTS: text → MP3 Buffer
   */
  async speak(text, timeout = 5000) {
    if (this._busy) throw new Error('TTS busy');
    this._busy = true;
    try {
      await this._ensureConnected();
      const ws = this._ws;
      ws.send(this._buildRequest(text));

      return new Promise((resolve, reject) => {
        const chunks = [];
        const timer = setTimeout(() => {
          resolve(Buffer.concat(chunks));
        }, timeout);

        ws.on('message', function onMsg(data) {
          if (!Buffer.isBuffer(data) || data.length < 4) return;
          const msgType = (data[1] >> 4) & 0x0f;
          const hSize = (data[0] & 0x0f) * 4;

          if (msgType === 0x0b) { // audio
            if (data.length > hSize + 8) {
              const seq = data.readInt32BE(hSize);
              const psize = data.readUInt32BE(hSize + 4);
              const audio = data.slice(hSize + 8, hSize + 8 + psize);
              if (audio.length > 0) chunks.push(audio);
              if (seq < 0) { // last chunk
                clearTimeout(timer);
                ws.removeListener('message', onMsg);
                resolve(Buffer.concat(chunks));
              }
            }
          } else if (msgType === 0x0f) { // error
            clearTimeout(timer);
            ws.removeListener('message', onMsg);
            reject(new Error('TTS server error'));
          }
        });
      });
    } finally {
      this._busy = false;
    }
  }

  /**
   * 流式 TTS: 每个 chunk 立刻回调，不等全部完成
   * onChunk(buffer, isLast) — buffer 是 MP3 片段
   */
  async speakChunked(text, onChunk, timeout = 8000) {
    if (this._busy) throw new Error('TTS busy');
    this._busy = true;
    // 带重试的流式 TTS
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt > 0) { this._ws = null; } // 重连
        await this._ensureConnected();
        const ws = this._ws;
        ws.send(this._buildRequest(text));

        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            ws.removeListener('message', onMsg);
            resolve();
          }, timeout);

          function onMsg(data) {
            if (!Buffer.isBuffer(data) || data.length < 4) return;
            const msgType = (data[1] >> 4) & 0x0f;
            const hSize = (data[0] & 0x0f) * 4;

            if (msgType === 0x0b) {
              if (data.length > hSize + 8) {
                const seq = data.readInt32BE(hSize);
                const psize = data.readUInt32BE(hSize + 4);
                const audio = data.slice(hSize + 8, hSize + 8 + psize);
                if (audio.length > 0) onChunk(audio, seq < 0);
                if (seq < 0) {
                  clearTimeout(timer);
                  ws.removeListener('message', onMsg);
                  resolve();
                }
              }
            } else if (msgType === 0x0f) {
              clearTimeout(timer);
              ws.removeListener('message', onMsg);
              reject(new Error('TTS server error'));
            }
          }
          ws.on('message', onMsg);
        });
        this._busy = false;
        return; // 成功，退出
      } catch (err) {
        if (attempt === 1) { this._busy = false; throw err; }
        // 第一次失败，重试
        console.warn('[TTS] retrying after error:', err.message);
      }
    }
    this._busy = false;
  }

  /**
   * macOS say 兜底（火山挂了用）
   */
  async speakFallback(text) {
    const { execFile } = require('child_process');
    return new Promise((resolve) => {
      execFile('say', ['-v', 'Tingting', '-r', '220', text], { timeout: 10000 }, () => resolve());
    });
  }

  close() {
    if (this._heartbeat) clearInterval(this._heartbeat);
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
  }

  /** WebSocket 心跳保活 */
  startHeartbeat() {
    if (this._heartbeat) return;
    this._heartbeat = setInterval(() => {
      if (this._ws && this._ws.readyState === WebSocket.OPEN && !this._busy) {
        try { this._ws.ping(); } catch { /* ignore */ }
      }
    }, 30000);
  }
}

// Singleton
let _instance = null;

function getTTS() {
  if (!_instance) {
    const appid = process.env.VOLC_TTS_APPID;
    const token = process.env.VOLC_TTS_TOKEN;
    if (!appid || !token) {
      throw new Error('VOLC_TTS_APPID and VOLC_TTS_TOKEN are required for Volc TTS');
    }
    _instance = new VolcStreamTTS({
      appid,
      token,
    });
    _instance.startHeartbeat();
  }
  return _instance;
}

module.exports = { VolcStreamTTS, getTTS };
