import * as db from './db.js';
import { AudioRecorder, isSupported as recSupported } from './recorder.js';
import { providers, WebSpeechTranscriber } from './transcription.js';
import { toMarkdown, toJSON, importJSON, saveFile, fmtDate, fmtDur } from './exporter.js';
import { getSettings, setSettings } from './settings.js';
import { isAiReady, summarize } from './ai.js';

const APP_VERSION = '0.1.0';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- state ----------
const state = { view: 'list', meta: [], query: '', tagFilter: null, current: null, audioUrl: null };

// ---------- toast ----------
let toastT;
function toast(msg, ms = 2400) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), ms);
}

// ---------- navigation ----------
const TITLES = { list: 'コンテキスト録音', record: '録音中', detail: '詳細', settings: '設定' };
function show(view) {
  state.view = view;
  for (const v of ['list', 'record', 'detail', 'settings']) $('#view-' + v).classList.toggle('hidden', v !== view);
  $('#viewTitle').textContent = TITLES[view];
  $('#backBtn').classList.toggle('hidden', view === 'list' || view === 'record');
  $('#settingsBtn').classList.toggle('hidden', view !== 'list');
  $('#recordBtn').classList.toggle('hidden', view !== 'list');
  window.scrollTo(0, 0);
}
$('#backBtn').onclick = async () => { await flushSave(); await refreshList(); show('list'); };
$('#settingsBtn').onclick = () => { renderSettings(); show('settings'); };

// ---------- list ----------
function allTags(meta = state.meta) {
  const people = new Map(), themes = new Map();
  for (const r of meta) {
    (r.people || []).forEach(t => people.set(t, (people.get(t) || 0) + 1));
    (r.themes || []).forEach(t => themes.set(t, (themes.get(t) || 0) + 1));
  }
  const sort = m => [...m.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
  return { people: sort(people), themes: sort(themes) };
}

function matches(r, terms) {
  if (state.tagFilter) {
    const { kind, tag } = state.tagFilter;
    if (!(r[kind] || []).includes(tag)) return false;
  }
  if (!terms.length) return true;
  const hay = [r.title, r.transcript, r.memo, ...(r.people || []), ...(r.themes || [])].join('\n').toLowerCase();
  return terms.every(t => hay.includes(t));
}

function highlight(text, terms) {
  let html = esc(text);
  for (const t of terms) {
    if (!t) continue;
    const re = new RegExp(esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    html = html.replace(re, m => `<mark>${m}</mark>`);
  }
  return html;
}

function snippet(r, terms) {
  const src = r.transcript || r.memo || '';
  if (!terms.length || !src) return src.slice(0, 120);
  const low = src.toLowerCase(); const i = low.indexOf(terms[0]);
  if (i < 0) return src.slice(0, 120);
  const s = Math.max(0, i - 30);
  return (s > 0 ? '…' : '') + src.slice(s, s + 120);
}

async function refreshList() { state.meta = await db.allMeta(); renderList(); }

function renderList() {
  const terms = state.query.toLowerCase().split(/[\s　]+/).filter(Boolean);
  const { people, themes } = allTags();
  const tf = state.tagFilter;
  $('#tagFilter').innerHTML =
    `<button class="chip ${!tf ? 'active' : ''}" data-all>すべて</button>` +
    people.map(t => `<button class="chip person ${tf && tf.kind === 'people' && tf.tag === t ? 'active' : ''}" data-kind="people" data-tag="${esc(t)}">${esc(t)}</button>`).join('') +
    themes.map(t => `<button class="chip theme ${tf && tf.kind === 'themes' && tf.tag === t ? 'active' : ''}" data-kind="themes" data-tag="${esc(t)}">${esc(t)}</button>`).join('');
  $('#tagFilter').classList.toggle('hidden', !people.length && !themes.length);

  const list = state.meta.filter(r => matches(r, terms));
  $('#emptyState').classList.toggle('hidden', state.meta.length > 0);
  $('#listMeta').textContent = state.meta.length ? (terms.length || tf ? `${list.length} / ${state.meta.length} 件` : `${state.meta.length} 件`) : '';
  let lastDay = '', html = '';
  for (const r of list) {
    const day = fmtDate(r.createdAt).slice(0, 10);
    if (day !== lastDay) { html += `<li class="day-head">${day}</li>`; lastDay = day; }
    const chips = [...(r.people || []).map(t => `<span class="chip person">${esc(t)}</span>`), ...(r.themes || []).map(t => `<span class="chip theme">${esc(t)}</span>`)].join('');
    html += `<li class="rec-item" data-id="${r.id}">
      <div class="t">${highlight(r.title, terms)}</div>
      <div class="sub">${fmtDate(r.createdAt).slice(11)} ・ ${fmtDur(r.durationMs)}${r.hasAudio ? '' : ' ・ 音声なし'}</div>
      <div class="snippet">${highlight(snippet(r, terms), terms) || '<span style="color:var(--muted)">（文字起こしなし）</span>'}</div>
      ${chips ? `<div class="chips">${chips}</div>` : ''}
    </li>`;
  }
  if (state.meta.length && !list.length) html = `<li class="empty">該当する録音がありません</li>`;
  $('#recList').innerHTML = html;
}

$('#tagFilter').onclick = e => {
  const b = e.target.closest('.chip'); if (!b) return;
  if (b.hasAttribute('data-all')) state.tagFilter = null;
  else {
    const f = { kind: b.dataset.kind, tag: b.dataset.tag };
    state.tagFilter = state.tagFilter && state.tagFilter.kind === f.kind && state.tagFilter.tag === f.tag ? null : f;
  }
  renderList();
};
$('#searchInput').oninput = e => { state.query = e.target.value; renderList(); };
$('#recList').onclick = e => { const li = e.target.closest('.rec-item'); if (li) openDetail(li.dataset.id); };

// ---------- recording ----------
let recorder = null, stt = null, timerT = null, finalParts = [];

function drawLevel(level) {
  const c = $('#levelMeter'), g = c.getContext('2d');
  const W = c.width, H = c.height;
  g.drawImage(c, -4, 0); g.clearRect(W - 4, 0, 4, H);
  const h = Math.max(2, level * H);
  g.fillStyle = '#ef4444'; g.fillRect(W - 3, (H - h) / 2, 2, h);
}

function setSttBadge(text, on) { const b = $('#sttState'); b.textContent = text; b.classList.toggle('on', !!on); }

function renderLive(interim = '') {
  const box = $('#liveTranscript');
  box.querySelector('.final').textContent = finalParts.join('\n');
  box.querySelector('.interim').textContent = (finalParts.length && interim ? '\n' : '') + interim;
  box.scrollTop = box.scrollHeight;
}

$('#recordBtn').onclick = startRecording;

async function startRecording() {
  if (!recSupported()) { toast('このブラウザは録音に対応していません'); return; }
  finalParts = []; renderLive();
  const c = $('#levelMeter'); c.getContext('2d').clearRect(0, 0, c.width, c.height);
  $('#recTimer').textContent = '00:00';
  $('#recState').textContent = 'マイク準備中…'; $('#recState').classList.remove('paused');
  $('#pauseBtn').textContent = '一時停止';
  show('record');
  recorder = new AudioRecorder({ onLevel: drawLevel });
  try { await recorder.start(); }
  catch (e) {
    console.error(e); show('list');
    toast(e.name === 'NotAllowedError' ? 'マイクの使用が許可されていません（設定 > Safari > マイク）' : '録音を開始できませんでした: ' + e.message, 4000);
    recorder = null; return;
  }
  $('#recState').textContent = '● 録音中';
  timerT = setInterval(() => { $('#recTimer').textContent = fmtDur(recorder.durationMs); }, 250);
  db.requestPersistence();

  const s = getSettings();
  if (s.sttEnabled && WebSpeechTranscriber.isSupported()) {
    stt = new providers.webspeech({ lang: 'ja-JP' });
    stt.start({
      onInterim: t => renderLive(t),
      onFinal: t => { finalParts.push(t); renderLive(); },
      onState: st => {
        if (st === 'listening') setSttBadge('認識中', true);
        else if (st === 'restarting') setSttBadge('再接続…');
        else if (st === 'denied') setSttBadge('許可なし');
        else if (st.startsWith('error')) setSttBadge('エラー ' + st.slice(6));
      }
    });
  } else {
    setSttBadge(s.sttEnabled ? '非対応' : 'オフ');
    $('#liveTranscript .interim').textContent = s.sttEnabled ? 'このブラウザはライブ文字起こしに対応していません。録音のみ保存されます。' : '';
  }
}

$('#pauseBtn').onclick = () => {
  if (!recorder) return;
  if (recorder.state === 'recording') {
    recorder.pause(); stt && stt.pause();
    $('#recState').textContent = '一時停止中'; $('#recState').classList.add('paused'); $('#pauseBtn').textContent = '再開';
    setSttBadge('一時停止');
  } else if (recorder.state === 'paused') {
    recorder.resume(); stt && stt.resume();
    $('#recState').textContent = '● 録音中'; $('#recState').classList.remove('paused'); $('#pauseBtn').textContent = '一時停止';
  }
};

$('#cancelBtn').onclick = () => {
  if (!confirm('この録音を破棄しますか？')) return;
  stt && stt.stop(); stt = null; recorder && recorder.cancel(); recorder = null;
  clearInterval(timerT); show('list');
};

$('#stopBtn').onclick = async () => {
  if (!recorder) return;
  clearInterval(timerT);
  $('#recState').textContent = '保存中…';
  stt && stt.stop();
  // Give recognition a moment to flush its last final result.
  await new Promise(r => setTimeout(r, stt ? 600 : 0));
  stt = null;
  const interim = $('#liveTranscript .interim').textContent.trim();
  if (interim && !interim.startsWith('このブラウザは')) finalParts.push(interim);
  const { blob, mimeType, durationMs } = await recorder.stop();
  recorder = null;
  const now = Date.now();
  const rec = {
    id: db.newId(), createdAt: now, title: fmtDate(now) + ' の録音', durationMs, mimeType,
    audio: blob.size ? await blob.arrayBuffer() : null,
    transcript: finalParts.join('\n'), transcriptSource: 'webspeech', memo: '', people: [], themes: [], summary: null, ai: {}
  };
  try { await db.put(rec); }
  catch (e) { console.error(e); toast('保存に失敗しました: ' + e.message, 4000); show('list'); return; }
  toast('保存しました');
  await refreshList();
  openDetail(rec.id);
};

// ---------- detail ----------
let saveT = null, dirty = false;
function scheduleSave() { dirty = true; $('#saveState').textContent = '編集中…'; clearTimeout(saveT); saveT = setTimeout(flushSave, 700); }
async function flushSave() {
  clearTimeout(saveT);
  if (!dirty || !state.current) return;
  dirty = false;
  const r = state.current;
  r.title = $('#dTitle').value.trim() || fmtDate(r.createdAt) + ' の録音';
  r.memo = $('#dMemo').value;
  const t = $('#dTranscript').value;
  if (t !== r.transcript) { r.transcript = t; r.transcriptEdited = true; }
  await db.put(r);
  $('#saveState').textContent = '保存済み ✓';
}
['#dTitle', '#dMemo', '#dTranscript'].forEach(s => $(s).addEventListener('input', scheduleSave));

async function openDetail(id) {
  await flushSave();
  const r = await db.get(id); if (!r) return;
  state.current = r;
  $('#dTitle').value = r.title;
  $('#dMemo').value = r.memo || '';
  $('#dTranscript').value = r.transcript || '';
  $('#dMeta').textContent = `${fmtDate(r.createdAt)} ・ ${fmtDur(r.durationMs)} ・ ${r.mimeType || ''}${r.audio ? ` ・ ${(r.audio.byteLength / 1024 / 1024).toFixed(1)}MB` : ''}`;
  if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
  state.audioUrl = r.audio ? URL.createObjectURL(new Blob([r.audio], { type: r.mimeType || 'audio/mp4' })) : null;
  const a = $('#dAudio'); a.classList.toggle('hidden', !state.audioUrl);
  if (state.audioUrl) a.src = state.audioUrl; else a.removeAttribute('src');
  $('#dSummarize').disabled = !isAiReady();
  $('#saveState').textContent = '';
  renderTagInputs();
  show('detail');
}

function renderTagInputs() {
  const r = state.current; const tags = allTags();
  for (const box of document.querySelectorAll('.tag-input')) {
    const kind = box.dataset.kind; const cls = kind === 'people' ? 'person' : 'theme';
    box.querySelector('.chips').innerHTML = (r[kind] || []).map(t => `<button class="chip ${cls}" data-tag="${esc(t)}">${esc(t)}<span class="x">×</span></button>`).join('');
  }
  $('#peopleList').innerHTML = tags.people.filter(t => !r.people.includes(t)).map(t => `<option value="${esc(t)}">`).join('');
  $('#themesList').innerHTML = tags.themes.filter(t => !r.themes.includes(t)).map(t => `<option value="${esc(t)}">`).join('');
}

async function addTag(kind, raw) {
  const r = state.current; if (!r) return;
  const vals = raw.split(/[,、，]/).map(s => s.trim().replace(/^[#＃@＠]/, '')).filter(Boolean);
  let changed = false;
  for (const v of vals) if (!r[kind].includes(v)) { r[kind].push(v); changed = true; }
  if (changed) { await db.put(r); state.meta = await db.allMeta(); renderTagInputs(); $('#saveState').textContent = '保存済み ✓'; }
}

for (const box of document.querySelectorAll('.tag-input')) {
  const input = box.querySelector('input'); const kind = box.dataset.kind;
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addTag(kind, input.value); input.value = ''; }
  });
  // datalist selection on iOS fires 'change'; also commit on blur
  input.addEventListener('change', () => { if (input.value.trim()) { addTag(kind, input.value); input.value = ''; } });
  box.querySelector('.chips').addEventListener('click', async e => {
    const c = e.target.closest('.chip'); if (!c) return;
    const r = state.current; r[kind] = r[kind].filter(t => t !== c.dataset.tag);
    await db.put(r); state.meta = await db.allMeta(); renderTagInputs();
  });
}

$('#dDelete').onclick = async () => {
  if (!state.current || !confirm('この録音を削除しますか？元に戻せません。')) return;
  dirty = false; await db.remove(state.current.id); state.current = null;
  await refreshList(); show('list'); toast('削除しました');
};

$('#dShare').onclick = async () => {
  await flushSave();
  const r = state.current; if (!r) return;
  const md = toMarkdown([r]);
  const choice = r.audio ? confirm('OK：文字起こし(Markdown)を共有\nキャンセル：音声ファイルを共有') : true;
  const base = r.title.replace(/[\\/:*?"<>|\s]+/g, '_');
  if (choice) await saveFile(base + '.md', md, 'text/markdown');
  else {
    const ext = (r.mimeType || '').includes('webm') ? 'webm' : 'm4a';
    await saveFile(base + '.' + ext, new Blob([r.audio], { type: r.mimeType }), r.mimeType || 'audio/mp4');
  }
};

$('#dSummarize').onclick = async () => {
  try { const s = await summarize(state.current); state.current.summary = s; await db.put(state.current); }
  catch (e) { toast(e.message); }
};

// ---------- settings ----------
async function renderSettings() {
  const s = getSettings();
  $('#sttEnabled').checked = s.sttEnabled;
  $('#sttProvider').value = s.sttProvider;
  $('#aiProvider').value = s.aiProvider;
  $('#aiKey').value = s.aiKey;
  $('#sttSupport').textContent = WebSpeechTranscriber.isSupported()
    ? 'このブラウザは音声認識に対応しています（iOSでは「設定 > 一般 > キーボード > 音声入力」がオンである必要があります）'
    : 'このブラウザは音声認識に対応していません。録音のみ保存されます。';
  const est = await db.estimate();
  $('#storageInfo').textContent = `${state.meta.length} 件` + (est ? ` ・ 使用量 約${(est.usage / 1024 / 1024).toFixed(1)}MB` : '');
  $('#versionInfo').textContent = `バージョン ${APP_VERSION}`;
}
$('#sttEnabled').onchange = e => setSettings({ sttEnabled: e.target.checked });
$('#sttProvider').onchange = e => setSettings({ sttProvider: e.target.value });
$('#aiProvider').onchange = e => setSettings({ aiProvider: e.target.value });
$('#aiKey').onchange = e => { setSettings({ aiKey: e.target.value.trim() }); toast('APIキーを端末に保存しました（機能は近日対応）'); };

const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };
$('#exportMd').onclick = async () => { const recs = await db.all(); await saveFile(`context-${stamp()}.md`, toMarkdown(recs), 'text/markdown'); };
$('#exportJson').onclick = async () => saveFile(`context-${stamp()}.json`, await toJSON(), 'application/json');
$('#exportJsonAudio').onclick = async () => { toast('書き出し中…'); await saveFile(`context-backup-${stamp()}.json`, await toJSON({ includeAudio: true }), 'application/json'); };
$('#importJson').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try { const { added, updated } = await importJSON(await f.text()); await refreshList(); renderSettings(); toast(`読み込み完了：追加 ${added} 件・更新 ${updated} 件`); }
  catch (err) { toast('読み込みに失敗しました: ' + err.message, 4000); }
  e.target.value = '';
};

// ---------- lifecycle ----------
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });
window.addEventListener('beforeunload', e => { if (recorder) { e.preventDefault(); e.returnValue = ''; } });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(e => console.warn('SW failed', e)));
}

refreshList().then(() => show('list'));
window.__app = { db, state, APP_VERSION }; // for debugging/tests
