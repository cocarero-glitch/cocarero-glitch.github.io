const KEY = 'context-recorder-settings';
const DEFAULTS = { sttEnabled: true, sttProvider: 'webspeech', aiProvider: 'openai', aiKey: '' };
export function getSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
}
export function setSettings(patch) {
  const s = { ...getSettings(), ...patch }; localStorage.setItem(KEY, JSON.stringify(s)); return s;
}
