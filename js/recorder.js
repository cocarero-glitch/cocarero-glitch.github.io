// Audio recorder wrapper around MediaRecorder with iOS Safari support (audio/mp4).
const CANDIDATES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/aac', 'audio/ogg;codecs=opus'];

export function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  // Prefer mp4 on Apple (plays back everywhere on iOS); webm elsewhere.
  const isApple = /iPhone|iPad|Macintosh/.test(navigator.userAgent) && !/Chrome|Android/.test(navigator.userAgent);
  const order = isApple ? CANDIDATES : ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/ogg;codecs=opus'];
  for (const t of order) { try { if (MediaRecorder.isTypeSupported(t)) return t; } catch {} }
  return ''; // let the browser choose
}

export function isSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && typeof MediaRecorder !== 'undefined');
}

export class AudioRecorder {
  constructor({ onLevel } = {}) {
    this.onLevel = onLevel; this.chunks = []; this.state = 'idle';
    this.elapsed = 0; this.startedAt = 0;
  }
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mimeType = pickMimeType();
    this.mr = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.mimeType = this.mr.mimeType || mimeType || 'audio/mp4';
    this.chunks = [];
    this.mr.ondataavailable = e => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.mr.start(1000);
    this.state = 'recording'; this.startedAt = performance.now(); this.elapsed = 0;
    this._meter();
  }
  get durationMs() { return this.elapsed + (this.state === 'recording' ? performance.now() - this.startedAt : 0); }
  pause() {
    if (this.state !== 'recording') return;
    this.mr.pause(); this.elapsed += performance.now() - this.startedAt; this.state = 'paused';
  }
  resume() {
    if (this.state !== 'paused') return;
    this.mr.resume(); this.startedAt = performance.now(); this.state = 'recording';
  }
  stop() {
    return new Promise(resolve => {
      const durationMs = this.durationMs;
      this.mr.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.mimeType.split(';')[0] });
        this._cleanup();
        resolve({ blob, mimeType: blob.type, durationMs });
      };
      this.state = 'stopped';
      try { this.mr.requestData(); } catch {}
      this.mr.stop();
    });
  }
  cancel() { try { this.mr && this.mr.state !== 'inactive' && this.mr.stop(); } catch {} this.state = 'stopped'; this._cleanup(); }
  _cleanup() {
    cancelAnimationFrame(this._raf);
    this.stream && this.stream.getTracks().forEach(t => t.stop());
    this.ac && this.ac.close().catch(() => {});
    this.ac = null;
  }
  _meter() {
    if (!this.onLevel) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ac = new AC();
      const src = this.ac.createMediaStreamSource(this.stream);
      const an = this.ac.createAnalyser(); an.fftSize = 512; src.connect(an);
      const buf = new Uint8Array(an.fftSize);
      const loop = () => {
        an.getByteTimeDomainData(buf);
        let sum = 0; for (const v of buf) { const x = (v - 128) / 128; sum += x * x; }
        this.onLevel(this.state === 'recording' ? Math.min(1, Math.sqrt(sum / buf.length) * 4) : 0);
        this._raf = requestAnimationFrame(loop);
      };
      loop();
    } catch (e) { console.warn('level meter unavailable', e); }
  }
}
