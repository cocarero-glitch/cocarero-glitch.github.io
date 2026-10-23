// Transcription providers. Add new providers here (e.g. Whisper) without touching UI code.
//  Live provider interface:  { id, label, isSupported(), start({onInterim,onFinal,onState}), stop() }
//  File provider interface:  { id, label, isSupported(), transcribeBlob(blob, {lang}) -> Promise<string> }

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

export class WebSpeechTranscriber {
  static id = 'webspeech';
  static label = '端末の音声認識';
  static isSupported() { return !!SR; }

  constructor({ lang = 'ja-JP' } = {}) { this.lang = lang; this.active = false; this.finalText = ''; }

  start({ onInterim, onFinal, onState } = {}) {
    if (!SR) { onState && onState('unsupported'); return; }
    this.active = true; this.onInterim = onInterim; this.onFinal = onFinal; this.onState = onState;
    this._restarts = 0; this._spawn();
  }

  _spawn() {
    if (!this.active) return;
    const rec = new SR();
    rec.lang = this.lang; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
    rec.onstart = () => this.onState && this.onState('listening');
    rec.onresult = e => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) { const t = r[0].transcript.trim(); if (t) this.onFinal && this.onFinal(t); }
        else interim += r[0].transcript;
      }
      this.onInterim && this.onInterim(interim);
    };
    rec.onerror = e => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.active = false; this.onState && this.onState('denied');
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
        this.onState && this.onState('error:' + e.error);
      }
    };
    // iOS Safari ends recognition after silence / ~1 min — restart automatically.
    rec.onend = () => {
      this.onInterim && this.onInterim('');
      if (!this.active) { this.onState && this.onState('stopped'); return; }
      this._restarts++;
      this.onState && this.onState('restarting');
      setTimeout(() => this._spawn(), this._restarts > 50 ? 1000 : 250);
    };
    this.rec = rec;
    try { rec.start(); } catch (e) { setTimeout(() => this._spawn(), 500); }
  }

  pause() { this.active = false; try { this.rec && this.rec.stop(); } catch {} }
  resume() { if (!this.active) { this.active = true; this._spawn(); } }
  stop() { this.active = false; try { this.rec && this.rec.stop(); } catch {} }
}

// Placeholder for future server-side transcription (OpenAI Whisper / gpt-4o-transcribe etc.).
export class WhisperTranscriber {
  static id = 'whisper';
  static label = 'Whisper API（近日対応）';
  static isSupported() { return false; }
  constructor({ apiKey, lang = 'ja' } = {}) { this.apiKey = apiKey; this.lang = lang; }
  async transcribeBlob(blob) {
    // TODO: POST multipart to https://api.openai.com/v1/audio/transcriptions
    //   form: file=<blob, name 'audio.m4a'>, model='whisper-1', language=this.lang
    throw new Error('Whisper文字起こしは近日対応です');
  }
}

export const providers = { webspeech: WebSpeechTranscriber, whisper: WhisperTranscriber };
