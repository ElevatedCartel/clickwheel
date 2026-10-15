import { db } from './db.js';
import { readTags } from './tags.js';

const ROWS = 7;
const TICK = (2 * Math.PI) / 28; // wheel angle per scroll step
const HOLD_MS = 450;

const $ = (s) => document.querySelector(s);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const cmp = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const ls = {
  get(k, d) { try { const v = localStorage.getItem('cw.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('cw.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text; // always text, never HTML: tags come from files
  return e;
}

function clock(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

// Fixed SVG strings (no user data goes in here).
const ICON = {
  chev: '<svg viewBox="0 0 10 16" aria-hidden="true"><path d="M2 1.5l6.5 6.5L2 14.5" fill="none" stroke="currentColor" stroke-width="2.8"/></svg>',
  check: '<svg viewBox="0 0 16 14" aria-hidden="true"><path d="M1.5 7.5l4.5 4.5L14.5 1.5" fill="none" stroke="currentColor" stroke-width="2.8"/></svg>',
  speaker: '<svg viewBox="0 0 24 20" aria-hidden="true"><path d="M1 6.5h4.5L12 1v18l-6.5-5.5H1z" fill="currentColor"/><path d="M15.5 6a5.5 5.5 0 010 8M18.5 3a9.5 9.5 0 010 14" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  grip: '<svg viewBox="0 0 16 12" aria-hidden="true"><path d="M0 1h16M0 6h16M0 11h16" stroke="currentColor" stroke-width="2"/></svg>',
  play: '<svg viewBox="0 0 10 12" aria-hidden="true"><path d="M0 0l10 6-10 6z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 10 12" aria-hidden="true"><path d="M0 0h3.6v12H0zM6.4 0H10v12H6.4z" fill="currentColor"/></svg>',
  note: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 17.5V5l11-2.5v12.5" fill="none" stroke="currentColor" stroke-width="1.6"/><ellipse cx="6.5" cy="17.5" rx="3" ry="2.4" fill="currentColor"/><ellipse cx="17.5" cy="15" rx="3" ry="2.4" fill="currentColor"/></svg>',
};

// ---------------------------------------------------------------- state

const S = {
  tracks: [],
  playlists: [],
  stack: [{ route: { t: 'main' }, sel: 0, top: 0 }],
  held: null,        // row being moved in Reorder
  scrubbing: false,
  showVolume: false,
  letter: null,      // big index letter while fast-scrolling
  queue: [],
  unshuffled: [],
  index: 0,
  playing: false,
  shuffle: ls.get('shuffle', false),
  repeat: ls.get('repeat', 'Off'),
  clicker: ls.get('clicker', true),
  haptics: ls.get('haptics', true),
  theme: ls.get('theme', 'silver'),
  volume: ls.get('volume', 0.8),
  storageText: '…',
};

const pagesEl = $('#pages');
const audio = new Audio();
audio.preload = 'auto';

// iOS fixes media volume at 1 (hardware buttons only); detect so the wheel scrubs instead.
const volumeSettable = (() => { const a = new Audio(); a.volume = 0.5; return a.volume === 0.5; })();
if (volumeSettable) audio.volume = S.volume;

// ---------------------------------------------------------------- library

const byId = (id) => S.tracks.find((t) => t.id === id);
const plById = (id) => S.playlists.find((p) => p.id === id);
const songs = () => [...S.tracks].sort((a, b) => cmp(a.title, b.title));
const artists = () => [...new Set(S.tracks.map((t) => t.artist))].sort(cmp);
function albums(artist) {
  const m = new Map();
  for (const t of S.tracks) if (!artist || t.artist === artist) m.set(t.artist + '\u0000' + t.album, { title: t.album, artist: t.artist });
  return [...m.values()].sort((a, b) => cmp(a.title, b.title));
}
const albumOrder = (a, b) => (a.album !== b.album ? cmp(a.album, b.album) : (a.trackNo ?? 1e9) - (b.trackNo ?? 1e9) || cmp(a.title, b.title));
const artistTracks = (a) => S.tracks.filter((t) => t.artist === a).sort(albumOrder);
const albumTracks = (al) => S.tracks.filter((t) => t.album === al.title && t.artist === al.artist).sort(albumOrder);
const plTracks = (p) => p.trackIds.map(byId).filter(Boolean);

const artURLs = new Map();
async function artURL(t) {
  if (!t?.hasArt) return null;
  if (artURLs.has(t.id)) return artURLs.get(t.id);
  const blob = await db.get('art', t.id);
  const url = blob ? URL.createObjectURL(blob) : null;
  artURLs.set(t.id, url);
  return url;
}

const AUDIO_EXT = /\.(mp3|m4a|m4b|aac|alac|mp4|wav|aif|aiff|caf|flac|ogg|oga|opus)$/i;
const MIME = { mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', alac: 'audio/mp4',
  wav: 'audio/wav', aif: 'audio/aiff', aiff: 'audio/aiff', caf: 'audio/x-caf', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg' };

async function importFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith('audio/') || AUDIO_EXT.test(f.name));
  if (!files.length) { toast('No audio files selected'); return; }
  let added = 0, skipped = 0;
  for (const [i, f] of files.entries()) {
    toast(`Importing ${i + 1} of ${files.length}…`, 0);
    if (S.tracks.some((t) => t.fileName === f.name && t.size === f.size)) { skipped++; continue; }
    try {
      const tags = await readTags(f);
      const id = crypto.randomUUID();
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      // Copy the bytes; iOS can discard the picker's temporary file later.
      await db.put('audio', new Blob([await f.arrayBuffer()], { type: f.type || MIME[ext] || 'audio/mpeg' }), id);
      if (tags.art) await db.put('art', tags.art, id);
      const t = {
        id,
        title: tags.title || f.name.replace(/\.[^.]+$/, ''),
        artist: tags.artist || 'Unknown Artist',
        album: tags.album || 'Unknown Album',
        trackNo: tags.trackNo ?? null,
        duration: 0, // filled in the first time it plays
        hasArt: !!tags.art,
        fileName: f.name,
        size: f.size,
        addedAt: Date.now(),
      };
      await db.put('tracks', t);
      S.tracks.push(t);
      added++;
    } catch (err) {
      console.error('Import failed', f.name, err);
      if (err?.name === 'QuotaExceededError') { toast('Out of storage space'); render(); return; }
    }
  }
  render();
  let msg = added ? `Imported ${plural(added, 'song')}` : 'Nothing imported';
  if (skipped) msg += `\n${skipped} already in library`;
  toast(msg);
  navigator.storage?.persist?.();
}

async function deleteTrack(id) {
  removeFromQueue(id);
  S.tracks = S.tracks.filter((t) => t.id !== id);
  for (const p of S.playlists) {
    if (p.trackIds.includes(id)) { p.trackIds = p.trackIds.filter((x) => x !== id); savePl(p); }
  }
  const u = artURLs.get(id);
  if (u) URL.revokeObjectURL(u);
  artURLs.delete(id);
  await Promise.all([db.del('tracks', id), db.del('audio', id), db.del('art', id)]);
}

const savePl = (p) => db.put('playlists', p).catch((e) => console.error(e));
const cleanName = (s) => String(s ?? '').trim().slice(0, 80);
function createPl(name, ids = []) {
  const p = { id: crypto.randomUUID(), name: cleanName(name) || 'Untitled Playlist', trackIds: ids, createdAt: Date.now() };
  S.playlists.push(p);
  savePl(p);
  return p;
}
function editPl(id, fn) { const p = plById(id); if (p) { fn(p); savePl(p); } }
const togglePl = (pid, tid) => editPl(pid, (p) => {
  p.trackIds = p.trackIds.includes(tid) ? p.trackIds.filter((x) => x !== tid) : [...p.trackIds, tid];
});
const movePl = (pid, from, to) => editPl(pid, (p) => { const [x] = p.trackIds.splice(from, 1); p.trackIds.splice(to, 0, x); });
function deletePl(id) { S.playlists = S.playlists.filter((p) => p.id !== id); db.del('playlists', id); }

// ---------------------------------------------------------------- player

let audioURL = null;
let loadSeq = 0;
let pendingSeek = null;
const current = () => S.queue[S.index];
const shuffled = (a) => { const r = a.slice(); for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; };

async function load(play) {
  const t = current();
  if (!t) return;
  const seq = ++loadSeq;
  const blob = await db.get('audio', t.id);
  if (seq !== loadSeq) return;
  if (!blob) { toast('Song file is missing'); return; }
  if (audioURL) URL.revokeObjectURL(audioURL);
  audioURL = URL.createObjectURL(blob);
  audio.src = audioURL;
  S.playing = play;
  if (play) audio.play().catch((e) => { if (e.name === 'NotAllowedError') { S.playing = false; render(); } });
  updateSession();
  render();
  saveResume();
}

function playList(list, start) {
  if (!list[start]) return;
  S.unshuffled = list.slice();
  if (S.shuffle) {
    const rest = list.slice();
    const [first] = rest.splice(start, 1);
    S.queue = [first, ...shuffled(rest)];
    S.index = 0;
  } else {
    S.queue = list.slice();
    S.index = start;
  }
  load(true);
}

function shuffleAll() {
  if (!S.tracks.length) { toast('No songs yet'); return false; }
  S.unshuffled = S.tracks.slice();
  S.queue = shuffled(S.tracks);
  S.index = 0;
  load(true);
  return true;
}

function reshuffle() {
  const now = current();
  if (!now) return;
  if (S.shuffle) {
    const rest = S.queue.filter((_, i) => i !== S.index);
    S.queue = [now, ...shuffled(rest)];
    S.index = 0;
  } else {
    S.queue = S.unshuffled.slice();
    S.index = Math.max(0, S.queue.findIndex((t) => t.id === now.id));
  }
}

function playNext(t) {
  if (!S.queue.length) { playList([t], 0); return; }
  S.queue.splice(S.index + 1, 0, t);
  S.unshuffled.push(t);
}

function resume() {
  if (!current()) return;
  if (!audio.src || audio.src === SILENT_WAV) { load(true); return; }
  audio.play().catch(() => {});
  S.playing = true;
  updateSession();
  render();
}
function pause() {
  audio.pause();
  S.playing = false;
  updateSession();
  render();
  saveResume();
}
const togglePlay = () => { if (current()) (S.playing ? pause : resume)(); };

function next() {
  if (!S.queue.length) return;
  if (S.index + 1 < S.queue.length) S.index++;
  else if (S.repeat === 'All') S.index = 0;
  else { pause(); seek(0); return; } // end of the queue: stop at the top of the last song
  load(S.playing);
}
function prev() {
  if (!S.queue.length) return;
  if (audio.currentTime > 3 || S.index === 0) seek(0);
  else { S.index--; load(S.playing); }
}
function seek(t) {
  const d = audio.duration;
  if (!Number.isFinite(d)) return;
  audio.currentTime = clamp(t, 0, Math.max(0, d - 0.25));
  updatePosition();
  if (top().route.t === 'nowPlaying') updateNP();
}

function removeFromQueue(id) {
  S.unshuffled = S.unshuffled.filter((t) => t.id !== id);
  const i = S.queue.findIndex((t) => t.id === id);
  if (i < 0) return;
  const wasCurrent = i === S.index;
  S.queue.splice(i, 1);
  if (i < S.index) S.index--;
  if (!S.queue.length) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    S.playing = false;
    S.index = 0;
    updateSession();
  } else if (wasCurrent) {
    S.index = Math.min(S.index, S.queue.length - 1);
    load(S.playing);
  }
  saveResume();
}

audio.addEventListener('ended', () => {
  if (unlocking || audio.src === SILENT_WAV) return;
  if (S.repeat === 'One') { audio.currentTime = 0; audio.play().catch(() => {}); } else next();
});
audio.addEventListener('play', () => { if (!unlocking) { S.playing = true; render(); } });
audio.addEventListener('pause', () => {
  // Phone calls, Siri, unplugged headphones: the system pauses us.
  if (!unlocking && !audio.ended && audio.src) { S.playing = false; render(); }
});
audio.addEventListener('loadedmetadata', () => {
  const t = current();
  if (t && !t.duration && Number.isFinite(audio.duration)) { t.duration = audio.duration; db.put('tracks', t); }
  if (pendingSeek != null) { audio.currentTime = pendingSeek; pendingSeek = null; }
  updatePosition();
});
let lastSave = 0;
audio.addEventListener('timeupdate', () => {
  if (top().route.t === 'nowPlaying') updateNP();
  const now = Date.now();
  if (now - lastSave > 5000) { lastSave = now; saveResume(); updatePosition(); }
});

function saveResume() {
  ls.set('resume', S.queue.length ? { ids: S.queue.map((t) => t.id), index: S.index, time: audio.currentTime || 0 } : null);
}
function restoreResume() {
  const r = ls.get('resume', null);
  if (!r?.ids) return;
  const q = r.ids.map(byId).filter(Boolean);
  if (!q.length) return;
  S.queue = q;
  S.unshuffled = q.slice();
  S.index = clamp(r.index | 0, 0, q.length - 1);
  pendingSeek = r.time || 0;
  load(false);
}

// Lock screen / Control Center / headphone buttons.
const ms = 'mediaSession' in navigator ? navigator.mediaSession : null;
if (ms) {
  const on = (a, f) => { try { ms.setActionHandler(a, f); } catch { /* unsupported action */ } };
  on('play', resume);
  on('pause', pause);
  on('nexttrack', next);
  on('previoustrack', prev);
  on('seekto', (e) => seek(e.seekTime));
}
async function updateSession() {
  if (!ms) return;
  const t = current();
  ms.playbackState = t ? (S.playing ? 'playing' : 'paused') : 'none';
  if (!t) { ms.metadata = null; return; }
  const art = await artURL(t);
  ms.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album, artwork: art ? [{ src: art, sizes: '512x512' }] : [] });
}
function updatePosition() {
  const d = audio.duration;
  if (!ms?.setPositionState || !Number.isFinite(d) || d <= 0) return;
  try { ms.setPositionState({ duration: d, playbackRate: 1, position: clamp(audio.currentTime, 0, d) }); } catch { /* ignore */ }
}

// iOS only lets a media element play after a tap has played it once. Prime it on the first touch
// so later plays (which wait on IndexedDB) are allowed.
let unlocked = false;
let unlocking = false;
function unlockAudio() {
  if (unlocked || !audio.paused) return;
  unlocked = unlocking = true;
  audio.muted = true;
  if (!audio.getAttribute('src')) audio.src = SILENT_WAV;
  audio.play()
    .then(() => { if (!S.playing) audio.pause(); })
    .catch(() => { unlocked = false; })
    .finally(() => { audio.muted = false; unlocking = false; });
}
const SILENT_WAV = (() => {
  const n = 64, b = new Uint8Array(44 + n * 2), v = new DataView(b.buffer);
  const w = (o, s) => [...s].forEach((c, i) => (b[o + i] = c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 16000, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  return 'data:audio/wav;base64,' + btoa(String.fromCharCode(...b));
})();

// ---------------------------------------------------------------- feedback

let ac = null, clickBuf = null;
function ensureClick() {
  if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ac = new AC();
  const n = 240;
  clickBuf = ac.createBuffer(1, n, ac.sampleRate);
  const d = clickBuf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.sin((2 * Math.PI * 3200 * i) / ac.sampleRate) * Math.exp(-i / 28) * 0.3;
}
function clickSound() {
  if (!S.clicker || !ac || ac.state !== 'running') return;
  const s = ac.createBufferSource();
  s.buffer = clickBuf;
  s.connect(ac.destination);
  s.start();
}
// Safari 18+ gives a haptic tap when a switch-style checkbox toggles; it's the only haptic a web app can trigger.
const hapticLabel = $('#haptic');
function haptic() { if (S.haptics) hapticLabel.click(); }
function tick() { haptic(); clickSound(); }

// ---------------------------------------------------------------- navigation

const top = () => S.stack[S.stack.length - 1];

function go(dir, mutate) {
  S.held = null;
  S.scrubbing = false;
  S.showVolume = false;
  mutate();
  const old = pagesEl.lastElementChild;
  const page = el('div', 'page');
  page.style.transform = `translateX(${dir * 100}%)`;
  pagesEl.append(page);
  render();
  void page.offsetWidth; // commit the start position before animating
  page.classList.add('anim');
  page.style.transform = 'translateX(0)';
  if (old) {
    old.classList.add('anim');
    old.style.transform = `translateX(${-dir * 100}%)`;
    setTimeout(() => old.remove(), 260);
  }
}
const push = (route, sel = 0) => go(1, () => S.stack.push({ route, sel, top: Math.max(0, sel - ROWS + 1) }));
const pop = () => { if (S.stack.length > 1) go(-1, () => S.stack.pop()); };
const popUntil = (keep) => go(-1, () => { while (S.stack.length > 1 && !keep(top().route)) S.stack.pop(); });

function sel() {
  const n = menuFor(top().route).items.length;
  return Math.min(top().sel, Math.max(0, n - 1));
}
function setSel(i) {
  const l = top();
  l.sel = i;
  if (i < l.top) l.top = i;
  if (i >= l.top + ROWS) l.top = i - ROWS + 1;
}

// ---------------------------------------------------------------- input

let lastTick = 0, streak = 0, letterTimer, volTimer;
const scrubMode = () => S.scrubbing || !volumeSettable;

function rotate(d) {
  const now = performance.now();
  streak = now - lastTick < 70 ? streak + 1 : 0;
  lastTick = now;
  const r = top().route;

  if (r.t === 'nowPlaying') {
    if (!current()) return;
    if (scrubMode()) {
      const dur = Number.isFinite(audio.duration) ? audio.duration : 0;
      seek(audio.currentTime + d * Math.max(1, dur / 120));
    } else {
      S.volume = clamp(S.volume + d * 0.025, 0, 1);
      audio.volume = S.volume;
      ls.set('volume', S.volume);
      S.showVolume = true;
      clearTimeout(volTimer);
      volTimer = setTimeout(() => { S.showVolume = false; render(); }, 1500);
    }
    tick();
    render();
    return;
  }

  const spec = menuFor(r);
  const n = spec.items.length;
  if (!n) return;
  const accel = n > 40 && S.held == null ? (streak > 30 ? 6 : streak > 12 ? 3 : 1) : 1;
  const old = sel();
  const nw = clamp(old + d * accel, 0, n - 1);
  if (nw === old) return;
  if (S.held != null && r.t === 'plReorder') { movePl(r.id, S.held, nw); S.held = nw; }
  setSel(nw);
  tick();
  if (accel > 1 && spec.alpha) {
    S.letter = (spec.items[nw].title[0] || '').toUpperCase();
    clearTimeout(letterTimer);
    letterTimer = setTimeout(() => { S.letter = null; renderOverlays(); }, 600);
  }
  render();
}

function press(b) {
  haptic();
  if (b === 'center') select();
  else if (b === 'menu') back();
  else if (b === 'playPause') togglePlay();
  else if (b === 'next') next();
  else if (b === 'previous') prev();
}

function select() {
  const r = top().route;
  if (r.t === 'nowPlaying') {
    if (volumeSettable) { S.scrubbing = !S.scrubbing; S.showVolume = false; render(); }
    return;
  }
  if (r.t === 'plReorder') {
    if (menuFor(r).items.length) S.held = S.held == null ? sel() : null;
    render();
    return;
  }
  menuFor(r).items[sel()]?.action?.();
  render();
}

function back() {
  if (S.scrubbing) { S.scrubbing = false; render(); return; }
  if (S.held != null) { S.held = null; render(); return; }
  pop();
}

function hold() {
  const r = top().route;
  if (r.t === 'nowPlaying') {
    const t = current();
    if (t) { haptic(); push({ t: 'songActions', id: t.id }); }
    return;
  }
  const it = menuFor(r).items[sel()];
  if (it?.hold) { haptic(); it.hold(); }
}

function tapRow(i) {
  if (S.held != null) return;
  setSel(i);
  haptic();
  select();
}

// ---- the wheel

const wheel = $('#wheel');
let g = null;

function buttonAt(dx, dy, centerR) {
  if (Math.hypot(dx, dy) < centerR) return 'center';
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI; // 0 = right, 90 = down
  if (deg >= -45 && deg < 45) return 'next';
  if (deg >= 45 && deg < 135) return 'playPause';
  if (deg >= -135 && deg < -45) return 'menu';
  return 'previous';
}
function showPressed(b) { wheel.dataset.pressed = b || ''; }

wheel.addEventListener('pointerdown', (e) => {
  if (g) return;
  e.preventDefault();
  unlockAudio();
  ensureClick();
  try { wheel.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
  const r = wheel.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2, R = r.width / 2;
  const dx = e.clientX - cx, dy = e.clientY - cy;
  if (Math.hypot(dx, dy) > R) return;
  const btn = buttonAt(dx, dy, R * 0.38);
  // Rotation only counts from the ring, never from the center button.
  g = { id: e.pointerId, cx, cy, R, btn, pressed: btn, last: btn === 'center' ? null : Math.atan2(dy, dx), acc: 0, trav: 0, held: false };
  showPressed(btn);
  const mine = g;
  g.timer = setTimeout(() => {
    if (g !== mine || !g.pressed) return;
    g.held = true;
    if (btn === 'next' || btn === 'previous') {
      g.scan = setInterval(() => seek(audio.currentTime + (btn === 'next' ? 4 : -4)), 180);
    } else if (btn === 'center') hold();
  }, HOLD_MS);
});

wheel.addEventListener('pointermove', (e) => {
  if (!g || e.pointerId !== g.id || g.last == null) return;
  const dx = e.clientX - g.cx, dy = e.clientY - g.cy;
  if (Math.hypot(dx, dy) < g.R * 0.27) return; // too close to the middle to read an angle
  const a = Math.atan2(dy, dx);
  let delta = a - g.last;
  if (delta > Math.PI) delta -= 2 * Math.PI;
  if (delta < -Math.PI) delta += 2 * Math.PI;
  g.last = a;
  g.acc += delta;
  g.trav += Math.abs(delta);
  if (g.trav > TICK * 0.6 && g.pressed && !g.held) {
    g.pressed = null; // it's a scroll, not a press
    clearTimeout(g.timer);
    showPressed(null);
  }
  // Screen y grows downward, so a positive delta is clockwise: move down the list.
  while (g.acc >= TICK) { g.acc -= TICK; rotate(1); }
  while (g.acc <= -TICK) { g.acc += TICK; rotate(-1); }
});

function endGesture(e) {
  if (!g || e.pointerId !== g.id) return;
  clearTimeout(g.timer);
  clearInterval(g.scan);
  const fire = e.type === 'pointerup' && g.pressed && !g.held ? g.pressed : null;
  g = null;
  showPressed(null);
  if (fire) press(fire);
}
wheel.addEventListener('pointerup', endGesture);
wheel.addEventListener('pointercancel', endGesture);
wheel.addEventListener('contextmenu', (e) => e.preventDefault());

// Desktop conveniences: scroll wheel / trackpad and keyboard.
let wheelAcc = 0;
wheel.addEventListener('wheel', (e) => {
  e.preventDefault();
  ensureClick();
  wheelAcc += e.deltaY;
  while (wheelAcc >= 30) { wheelAcc -= 30; rotate(1); }
  while (wheelAcc <= -30) { wheelAcc += 30; rotate(-1); }
}, { passive: false });

document.addEventListener('keydown', (e) => {
  if (!$('#modal').hidden || e.metaKey || e.ctrlKey || e.altKey) return;
  const map = { ArrowDown: () => rotate(1), j: () => rotate(1), ArrowUp: () => rotate(-1), k: () => rotate(-1),
    Enter: () => press('center'), Escape: () => press('menu'), Backspace: () => press('menu'),
    ' ': () => press('playPause'), ArrowRight: () => press('next'), ArrowLeft: () => press('previous') };
  const f = map[e.key];
  if (!f) return;
  e.preventDefault();
  unlockAudio();
  ensureClick();
  f();
});

// ---------------------------------------------------------------- menus

const item = (title, action, more = {}) => ({ title, action, acc: 'chev', ...more });

function songRows(list) {
  const playingId = current()?.id;
  return list.map((t, i) => ({
    title: t.title,
    acc: t.id === playingId ? 'speaker' : null,
    action: () => { playList(list, i); push({ t: 'nowPlaying' }); },
    hold: () => push({ t: 'songActions', id: t.id }),
  }));
}

function cycle(list, v) { return list[(list.indexOf(v) + 1) % list.length]; }

function menuFor(r) {
  switch (r.t) {
    case 'main': {
      const items = [
        item('Music', () => push({ t: 'music' })),
        item('Playlists', () => push({ t: 'playlists' })),
        item('Shuffle Songs', () => { if (shuffleAll()) push({ t: 'nowPlaying' }); }, { acc: null }),
        item('Import Songs', () => $('#picker').click(), { acc: null }),
        item('Settings', () => push({ t: 'settings' })),
      ];
      if (current()) items.push(item('Now Playing', () => push({ t: 'nowPlaying' })));
      return { title: 'iPod', items };
    }
    case 'music':
      return { title: 'Music', items: [
        item('Playlists', () => push({ t: 'playlists' })),
        item('Artists', () => push({ t: 'artists' })),
        item('Albums', () => push({ t: 'albums' })),
        item('Songs', () => push({ t: 'songs' })),
      ] };
    case 'songs':
      return { title: 'Songs', items: songRows(songs()), alpha: true, empty: 'No songs.\nChoose Import Songs\nfrom the main menu.' };
    case 'artists':
      return { title: 'Artists', items: artists().map((a) => item(a, () => push({ t: 'artist', name: a }))), alpha: true, empty: 'No artists' };
    case 'artist':
      return { title: r.name, items: [
        item('All Songs', () => { const ts = artistTracks(r.name); if (ts.length) { playList(ts, 0); push({ t: 'nowPlaying' }); } }),
        ...albums(r.name).map((al) => item(al.title, () => push({ t: 'album', title: al.title, artist: al.artist }))),
      ] };
    case 'albums':
      return { title: 'Albums', items: albums().map((al) => item(al.title, () => push({ t: 'album', title: al.title, artist: al.artist }))), alpha: true, empty: 'No albums' };
    case 'album':
      return { title: r.title, items: songRows(albumTracks(r)), empty: 'No songs' };

    case 'playlists':
      return { title: 'Playlists', items: [
        item('New Playlist…', () => ask('New Playlist', '', (name) => { const p = createPl(name); push({ t: 'plAdd', id: p.id }); }), { acc: null }),
        ...S.playlists.map((p) => item(p.name, () => push({ t: 'playlist', id: p.id }, p.trackIds.length ? 1 : 0), { detail: p.trackIds.length })),
      ] };
    case 'playlist': {
      const p = plById(r.id);
      if (!p) return { title: 'Playlist', items: [] };
      const empty = !p.trackIds.length;
      return { title: p.name, items: [
        item(empty ? 'Add Songs…' : 'Edit Playlist', () => push({ t: empty ? 'plAdd' : 'plEdit', id: p.id })),
        ...songRows(plTracks(p)),
      ] };
    }
    case 'plEdit': {
      const p = plById(r.id);
      return { title: 'Edit', items: [
        item('Add Songs', () => push({ t: 'plAdd', id: r.id })),
        item('Remove Songs', () => push({ t: 'plRemove', id: r.id })),
        item('Reorder Songs', () => push({ t: 'plReorder', id: r.id })),
        item('Rename', () => ask('Rename Playlist', p?.name, (name) => editPl(r.id, (x) => { x.name = cleanName(name) || x.name; })), { acc: null }),
        item('Delete Playlist', () => push({ t: 'plDelete', id: r.id })),
      ] };
    }
    case 'plAdd': {
      const p = plById(r.id);
      return { title: 'Add Songs', alpha: true, empty: 'No songs to add.\nImport some first.',
        items: songs().map((t) => ({ title: t.title, acc: { check: !!p?.trackIds.includes(t.id) }, action: () => togglePl(r.id, t.id) })) };
    }
    case 'plRemove': {
      const p = plById(r.id);
      return { title: 'Remove Songs', empty: 'Playlist is empty',
        items: (p ? plTracks(p) : []).map((t, i) => ({ title: t.title, acc: { value: 'Remove' },
          action: () => { editPl(r.id, (x) => x.trackIds.splice(i, 1)); toast('Removed'); } })) };
    }
    case 'plReorder': {
      const p = plById(r.id);
      return { title: S.held == null ? 'Reorder' : 'Moving…', empty: 'Playlist is empty',
        items: (p ? plTracks(p) : []).map((t, i) => ({ title: t.title, acc: S.held === i ? 'grip' : null })) };
    }
    case 'plDelete':
      return { title: 'Delete?', items: [
        item('Cancel', pop, { acc: null }),
        item('Delete Playlist', () => { deletePl(r.id); popUntil((x) => x.t === 'playlists'); }, { acc: null }),
      ] };

    case 'songActions': {
      const t = byId(r.id);
      if (!t) return { title: 'Song', items: [] };
      return { title: t.title, items: [
        item('Play Next', () => { playNext(t); toast('Playing next'); pop(); }, { acc: null }),
        item('Add to Playlist', () => push({ t: 'addTo', id: t.id })),
        item('Go to Album', () => push({ t: 'album', title: t.album, artist: t.artist })),
        item('Go to Artist', () => push({ t: 'artist', name: t.artist })),
        item('Delete from Library', () => push({ t: 'songDelete', id: t.id })),
      ] };
    }
    case 'addTo':
      return { title: 'Add to Playlist', items: [
        item('New Playlist…', () => ask('New Playlist', '', (name) => { const p = createPl(name, [r.id]); toast(`Added to ${p.name}`); render(); }), { acc: null }),
        ...S.playlists.map((p) => ({ title: p.name, acc: { check: p.trackIds.includes(r.id) }, action: () => togglePl(p.id, r.id) })),
      ] };
    case 'songDelete':
      return { title: 'Delete?', items: [
        item('Cancel', pop, { acc: null }),
        item('Delete Song', async () => {
          await deleteTrack(r.id);
          toast('Song deleted');
          popUntil((x) => x.t !== 'nowPlaying' && !(['songActions', 'songDelete', 'addTo'].includes(x.t) && x.id === r.id));
        }, { acc: null }),
      ] };

    case 'settings':
      return { title: 'Settings', items: [
        item('About', () => { refreshStorage(); push({ t: 'about' }); }),
        item('Shuffle', () => { S.shuffle = !S.shuffle; ls.set('shuffle', S.shuffle); reshuffle(); }, { acc: { value: S.shuffle ? 'Songs' : 'Off' } }),
        item('Repeat', () => { S.repeat = cycle(['Off', 'One', 'All'], S.repeat); ls.set('repeat', S.repeat); }, { acc: { value: S.repeat } }),
        item('Clicker', () => { S.clicker = !S.clicker; ls.set('clicker', S.clicker); }, { acc: { value: S.clicker ? 'On' : 'Off' } }),
        item('Haptics', () => { S.haptics = !S.haptics; ls.set('haptics', S.haptics); }, { acc: { value: S.haptics ? 'On' : 'Off' } }),
        item('Finish', () => { S.theme = cycle(['white', 'silver', 'black'], S.theme); ls.set('theme', S.theme); applyTheme(); },
          { acc: { value: S.theme[0].toUpperCase() + S.theme.slice(1) } }),
        item('Back Up Playlists', backup, { acc: null }),
        item('Restore Playlists', () => $('#restore').click(), { acc: null }),
      ] };
    case 'about': {
      const total = S.tracks.reduce((s, t) => s + (t.duration || 0), 0);
      const info = (title, value) => ({ title, acc: { value: String(value) } });
      return { title: 'About', items: [
        info('Songs', S.tracks.length),
        info('Playlists', S.playlists.length),
        info('Total Time', clock(total)),
        info('Storage Used', S.storageText),
        info('Version', '1.0'),
      ] };
    }
    case 'nowPlaying':
      return { title: 'Now Playing', items: [] };
  }
  return { title: '', items: [] };
}

async function refreshStorage() {
  try {
    const { usage } = await navigator.storage.estimate();
    S.storageText = usage > 1e9 ? `${(usage / 1e9).toFixed(1)} GB` : `${Math.round(usage / 1e6)} MB`;
  } catch { S.storageText = '—'; }
  render();
}

// ---------------------------------------------------------------- playlist backup

async function backup() {
  if (!S.playlists.length) { toast('No playlists yet'); return; }
  const data = {
    app: 'ClickWheel', version: 1, exported: new Date().toISOString(),
    playlists: S.playlists.map((p) => ({ name: p.name, songs: plTracks(p).map((t) => ({ title: t.title, artist: t.artist, album: t.album })) })),
  };
  const file = new File([JSON.stringify(data, null, 2)], 'clickwheel-playlists.json', { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = el('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function restore(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { data = null; }
  if (!Array.isArray(data?.playlists)) { toast('Not a playlist backup'); return; }
  const key = (t, a) => `${t}\u0000${a}`.toLowerCase();
  const index = new Map(S.tracks.map((t) => [key(t.title, t.artist), t.id]));
  let made = 0, missing = 0;
  for (const p of data.playlists) {
    if (typeof p?.name !== 'string' || !Array.isArray(p.songs)) continue;
    const ids = [];
    for (const s of p.songs) {
      const id = index.get(key(String(s?.title), String(s?.artist)));
      if (id) { if (!ids.includes(id)) ids.push(id); } else missing++;
    }
    const existing = S.playlists.find((x) => x.name === p.name);
    if (existing) editPl(existing.id, (x) => { for (const id of ids) if (!x.trackIds.includes(id)) x.trackIds.push(id); });
    else createPl(p.name, ids);
    made++;
  }
  toast(`Restored ${plural(made, 'playlist')}` + (missing ? `\n${missing} songs not in library` : ''));
  render();
}

// ---------------------------------------------------------------- rendering

const stTitle = $('#st-title');
const stPlay = $('#st-play');

function render() {
  const page = pagesEl.lastElementChild;
  if (!page) return;
  const r = top().route;
  const spec = menuFor(r);
  stTitle.textContent = spec.title;
  const playState = current() ? (S.playing ? 'play' : 'pause') : '';
  if (stPlay.dataset.state !== playState) {
    stPlay.dataset.state = playState;
    stPlay.innerHTML = playState ? ICON[playState] : '';
  }
  if (r.t === 'nowPlaying') renderNP(page);
  else if (r.t === 'main') renderMain(page, spec);
  else { page.dataset.kind = 'list'; page.replaceChildren(listEl(spec)); }
  renderOverlays();
}

function accEl(acc) {
  if (!acc) return null;
  const a = el('span', 'acc');
  if (typeof acc === 'string') a.innerHTML = ICON[acc];
  else if ('check' in acc) { a.innerHTML = ICON.check; a.classList.toggle('off', !acc.check); }
  else if ('value' in acc) { a.textContent = acc.value; a.classList.add('val'); }
  return a;
}

function listEl(spec) {
  const wrap = el('div', 'listwrap');
  const n = spec.items.length;
  if (!n) { wrap.append(el('div', 'empty', spec.empty || 'No items')); return wrap; }
  const s = sel();
  const start = Math.min(top().top, Math.max(0, n - ROWS));
  const list = el('div', 'list' + (n > ROWS ? ' has-bar' : ''));
  for (let i = start; i < Math.min(n, start + ROWS); i++) {
    const it = spec.items[i];
    const row = el('div', 'row' + (i === s ? ' sel' : '') + (S.held === i ? ' held' : ''));
    row.append(el('span', 't', it.title));
    if (it.detail != null) row.append(el('span', 'd', String(it.detail)));
    const a = accEl(it.acc);
    if (a) row.append(a);
    row.addEventListener('click', () => { unlockAudio(); ensureClick(); tapRow(i); });
    list.append(row);
  }
  wrap.append(list);
  if (n > ROWS) {
    const bar = el('div', 'scrollbar');
    const thumb = el('div', 'thumb');
    const h = Math.max((ROWS / n) * 100, 8);
    thumb.style.height = h + '%';
    thumb.style.top = ((100 - h) * start) / (n - ROWS) + '%';
    bar.append(thumb);
    wrap.append(bar);
  }
  return wrap;
}

function setArt(box, t) {
  const id = t?.hasArt ? t.id : '';
  if (box.dataset.id === id && box.firstChild) return;
  box.dataset.id = id;
  const ph = el('div', 'ph');
  ph.innerHTML = ICON.note;
  box.replaceChildren(ph);
  if (!id) return;
  artURL(t).then((u) => {
    if (!u || box.dataset.id !== id) return;
    const img = el('img');
    img.alt = '';
    img.src = u;
    box.replaceChildren(img);
  });
}

function renderMain(page, spec) {
  if (page.dataset.kind !== 'main') {
    page.dataset.kind = 'main';
    page.replaceChildren(el('div', 'half'), el('div', 'side'));
    page.classList.add('split');
  }
  page.firstChild.replaceChildren(listEl(spec));
  setArt(page.lastChild, current());
}

function renderNP(page) {
  if (page.dataset.kind !== 'np') {
    page.dataset.kind = 'np';
    page.innerHTML = `
      <div class="np">
        <div class="np-count"></div>
        <div class="np-main">
          <div class="np-art"><div class="cover"></div><div class="refl"></div></div>
          <div class="np-text"><div class="np-title"></div><div class="np-artist"></div><div class="np-album"></div></div>
        </div>
        <div class="np-bottom">
          <div class="np-progress">
            <div class="bar"><div class="fill"></div><div class="diamond"></div></div>
            <div class="times"><span class="el"></span><span class="rem"></span></div>
          </div>
          <div class="np-volume"><span class="vi lo"></span><div class="bar"><div class="fill"></div></div><span class="vi hi"></span></div>
        </div>
      </div>`;
    page.querySelector('.vi.lo').innerHTML = ICON.speaker;
    page.querySelector('.vi.hi').innerHTML = ICON.speaker;
  }
  updateNP(page);
}

function updateNP(page = pagesEl.lastElementChild) {
  if (page?.dataset.kind !== 'np') return;
  const t = current();
  const q = (s) => page.querySelector(s);
  q('.np').classList.toggle('empty-np', !t);
  q('.np-count').textContent = t ? `${S.index + 1} of ${S.queue.length}` : 'Nothing playing';
  q('.np-title').textContent = t?.title ?? '';
  q('.np-artist').textContent = t?.artist ?? '';
  q('.np-album').textContent = t?.album ?? '';
  setArt(q('.cover'), t);
  setArt(q('.refl'), t);
  const dur = Number.isFinite(audio.duration) ? audio.duration : t?.duration || 0;
  const pos = audio.currentTime || 0;
  const frac = dur ? clamp(pos / dur, 0, 1) : 0;
  q('.np-progress .fill').style.width = frac * 100 + '%';
  q('.diamond').style.left = frac * 100 + '%';
  q('.np-progress').classList.toggle('scrub', S.scrubbing || (!volumeSettable && !!t));
  q('.el').textContent = clock(pos);
  q('.rem').textContent = '-' + clock(Math.max(0, dur - pos));
  q('.np-volume .fill').style.width = S.volume * 100 + '%';
  q('.np-bottom').classList.toggle('vol', S.showVolume);
}

let toastTimer;
function toast(msg, ms = 1600) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function renderOverlays() {
  const l = $('#letter');
  l.hidden = !S.letter;
  l.textContent = S.letter ?? '';
}

// ---------------------------------------------------------------- name prompt

let onName = null;
function ask(title, prefill, cb) {
  $('#modal-title').textContent = title;
  const input = $('#modal-input');
  input.value = prefill ?? '';
  $('#modal').hidden = false;
  input.focus();
  input.select();
  onName = cb;
}
function closeModal() { $('#modal').hidden = true; $('#modal-input').blur(); onName = null; }
$('#modal-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const cb = onName;
  const v = $('#modal-input').value;
  closeModal();
  cb?.(v);
  render();
});
$('#modal-cancel').addEventListener('click', closeModal);

// ---------------------------------------------------------------- file pickers

$('#picker').addEventListener('change', async (e) => {
  const files = e.target.files;
  if (files?.length) await importFiles(files);
  e.target.value = '';
});
$('#restore').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  if (f) await restore(f);
  e.target.value = '';
});

// ---------------------------------------------------------------- layout & theme

function applyTheme() {
  $('#ipod').className = 'theme-' + S.theme;
  const color = { white: '#f4f4f5', silver: '#cfd0d4', black: '#151517' }[S.theme];
  document.querySelector('meta[name="theme-color"]').content = color;
}

function layout() {
  const ip = $('#ipod');
  const cs = getComputedStyle(ip);
  const W = ip.clientWidth;
  const H = ip.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const gap = W * 0.07;
  const wheelD = Math.min(W * 0.78, 400, H * 0.47);
  const bezelPad = W * 0.018;
  const screenW = Math.min(W * 0.86, 520, ((H - wheelD - gap * 2) / 0.75) - bezelPad * 2);
  const screenH = screenW * 0.75;
  const screen = $('#screen');
  screen.style.width = screenW + 'px';
  screen.style.height = screenH + 'px';
  screen.style.setProperty('--u', screenH / 100 + 'px');
  $('#bezel').style.padding = bezelPad + 'px';
  $('#bezel').style.marginTop = gap * 0.6 + 'px';
  wheel.style.width = wheel.style.height = wheelD + 'px';
}
addEventListener('resize', layout);

// ---------------------------------------------------------------- boot

async function boot() {
  applyTheme();
  layout();
  pagesEl.append(el('div', 'page'));
  try {
    const [tracks, playlists] = await Promise.all([db.all('tracks'), db.all('playlists')]);
    S.tracks = tracks;
    S.playlists = playlists.sort((a, b) => a.createdAt - b.createdAt);
    restoreResume();
  } catch (err) {
    console.error(err);
    toast('Storage unavailable.\nPrivate Browsing?', 4000);
  }
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
}
addEventListener('pagehide', saveResume);
boot();
