// Export / import. Markdown is designed to be pasted into an AI as context.
import * as db from './db.js';

const pad = n => String(n).padStart(2, '0');
export function fmtDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fmtDur(ms) {
  const s = Math.round((ms || 0) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
}

export function toMarkdown(recs) {
  const lines = [`# 録音コンテキスト`, ``, `書き出し日時: ${fmtDate(Date.now())} / 件数: ${recs.length}`, ``];
  for (const r of [...recs].sort((a, b) => a.createdAt - b.createdAt)) {
    lines.push(`## ${r.title}`, ``);
    lines.push(`- 日時: ${fmtDate(r.createdAt)}`);
    lines.push(`- 長さ: ${fmtDur(r.durationMs)}`);
    if (r.people?.length) lines.push(`- 人: ${r.people.join(', ')}`);
    if (r.themes?.length) lines.push(`- テーマ: ${r.themes.join(', ')}`);
    lines.push(``);
    if (r.memo) lines.push(`### メモ`, ``, r.memo, ``);
    if (r.summary) lines.push(`### 要約`, ``, r.summary, ``);
    lines.push(`### 文字起こし`, ``, r.transcript || '（なし）', ``);
  }
  return lines.join('\n');
}

function abToB64(buf) {
  const bytes = new Uint8Array(buf); let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64ToAb(b64) {
  const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export async function toJSON({ includeAudio = false } = {}) {
  const recs = await db.all();
  return JSON.stringify({
    app: 'context-recorder', version: 1, exportedAt: new Date().toISOString(),
    recordings: recs.map(({ audio, ...r }) => ({ ...r, createdAtISO: new Date(r.createdAt).toISOString(),
      ...(includeAudio && audio ? { audioBase64: abToB64(audio) } : {}) }))
  }, null, 2);
}

export async function importJSON(text) {
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : data.recordings;
  if (!Array.isArray(list)) throw new Error('形式が正しくありません');
  let added = 0, updated = 0;
  for (const r of list) {
    if (!r || !r.createdAt) continue;
    const id = r.id || db.newId();
    const existing = await db.get(id);
    const { audioBase64, createdAtISO, hasAudio, audioBytes, ...rest } = r;
    const rec = {
      transcript: '', memo: '', people: [], themes: [], summary: null, ai: {},
      ...existing, ...rest, id,
      audio: audioBase64 ? b64ToAb(audioBase64) : (existing?.audio || null),
    };
    await db.put(rec); existing ? updated++ : added++;
  }
  return { added, updated };
}

/** Save a file on iPhone: prefer the share sheet (→「ファイルに保存」), fall back to download link. */
export async function saveFile(name, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  try {
    const file = new File([blob], name, { type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: name });
      return 'shared';
    }
  } catch (e) { if (e.name === 'AbortError') return 'cancelled'; }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'downloaded';
}
