import { RIGHT_PATTERNS, LEFT_PATTERNS } from './patterns.js';

/* ============================================================
 * 設定の保存
 * ============================================================ */
const STORE_KEY = 'rhythm-challenge-settings-v1';
const defaults = {
  bpm: 90, subdiv: 1, metroInPlay: true, guide: false, tapSound: true,
  volume: 0.8, offset: 0, handMode: 'both', beats: 4,
};
let settings = { ...defaults };
try {
  const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
  settings = { ...defaults, ...saved };
} catch (_) { /* ignore */ }
function saveSettings() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (_) { /* ignore */ }
}

/* ============================================================
 * オーディオ
 * ============================================================ */
let ctx = null;
let master = null;

function ensureAudio() {
  if (!ctx) {
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (_) { /* ignore */ }
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC({ latencyHint: 'interactive' });
    master = ctx.createGain();
    master.gain.value = settings.volume;
    master.connect(ctx.destination);
    // iOS のロック解除用に無音を鳴らす
    const buf = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
  }
  if (ctx.state !== 'running') ctx.resume();
  return ctx;
}

function blip(time, freq, dur, gain, type = 'sine', drop = 1) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq * drop, time);
  if (drop !== 1) o.frequency.exponentialRampToValueAtTime(freq, time + 0.025);
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(gain, time + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
  o.connect(g).connect(master);
  o.start(time);
  o.stop(time + dur + 0.02);
}

// メトロノームのクリック: level 0 = 小節頭, 1 = 拍, 2 = 細分
function click(time, level) {
  if (level === 0) blip(time, 1760, 0.06, 0.55, 'square');
  else if (level === 1) blip(time, 1175, 0.05, 0.4, 'square');
  else blip(time, 880, 0.035, 0.16, 'square');
}

// 手の音: 左 = 低め「ドン」, 右 = 高め「タン」
function handSound(time, hand, gain = 0.7) {
  if (hand === 'L') blip(time, 180, 0.16, gain, 'triangle', 2.2);
  else blip(time, 520, 0.12, gain * 0.8, 'triangle', 1.8);
}

// イベントの timeStamp を「いま耳に届いている音」のオーディオ時刻に変換
function audioTimeOfEvent(ev) {
  let t;
  if (ctx.getOutputTimestamp) {
    const ts = ctx.getOutputTimestamp();
    if (ts && ts.contextTime > 0 && ts.performanceTime > 0) {
      const evMs = ev && ev.timeStamp > 0 ? ev.timeStamp : performance.now();
      t = ts.contextTime + (evMs - ts.performanceTime) / 1000;
    }
  }
  if (t === undefined) {
    t = ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
  }
  return t - settings.offset / 1000;
}
function heardNow() {
  return audioTimeOfEvent(null) + settings.offset / 1000;
}

/* ============================================================
 * 問題
 * ============================================================ */
const HANDS = ['L', 'R'];
let problem = null; // { L: {ids, cells}, R: {ids, cells} }

// 4拍パターンをランダムにつなげて、指定の拍数ぶんのリズムを作る
function buildHand(patterns, beats) {
  const ids = [];
  const cells = [];
  while (cells.length < beats) {
    let i;
    do { i = Math.floor(Math.random() * patterns.length); } while (ids.length && i === ids[ids.length - 1] - 1);
    ids.push(i + 1);
    cells.push(...patterns[i]);
  }
  return { ids, cells: cells.slice(0, beats) };
}

function newProblem() {
  problem = {
    L: buildHand(LEFT_PATTERNS, settings.beats),
    R: buildHand(RIGHT_PATTERNS, settings.beats),
  };
  const fmtIds = (ids) => ids.map((i) => `#${i}`).join(',');
  document.getElementById('patternInfo').textContent =
    `${settings.beats}拍 ・ 左 ${fmtIds(problem.L.ids)} / 右 ${fmtIds(problem.R.ids)}`;
  renderScore();
  hideResult();
}

// 1拍(4文字)を音符・休符のトークンに分解
function parseCell(cell) {
  const tokens = [];
  let i = 0;
  while (i < 4) {
    if (cell[i] === 'x') {
      let d = 1;
      while (i + d < 4 && cell[i + d] === '-') d++;
      tokens.push({ type: 'note', slot: i, dur: d });
      i += d;
    } else {
      let j = i;
      while (j < 4 && cell[j] === '.') j++;
      let s = i;
      while (s < j) {
        if (s % 2 === 0 && j - s >= 2) { tokens.push({ type: 'rest', slot: s, dur: 2 }); s += 2; }
        else { tokens.push({ type: 'rest', slot: s, dur: 1 }); s += 1; }
      }
      i = j;
    }
  }
  return tokens;
}

/* ============================================================
 * 楽譜の描画 (SVG)
 * ============================================================ */
const SVGNS = 'http://www.w3.org/2000/svg';
const COLW = 190;      // 1列の幅
const HEADER = 34;
const ROWH = 78;
const SP = 34;         // 16分音符ひとつぶんの横幅
const NOTE_X0 = 38;    // 列内での最初の音符の x
const STEM = 38;
const W = COLW * 2;
let rows = 4;
const svgH = () => HEADER + ROWH * rows + 8;
const COL_X = { L: 0, R: COLW };

let svg, noteEls, rowHl, playheads, colGroups;

function el(name, attrs = {}, parent) {
  const e = document.createElementNS(SVGNS, name);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
const baseY = (row) => HEADER + row * ROWH + 58;

function drawRest(g, cx, by, dur) {
  if (dur === 2) {
    el('circle', { cx: cx - 3, cy: by - 22, r: 3.4, class: 'ink' }, g);
    el('path', { d: `M${cx - 4},${by - 19} Q${cx + 1},${by - 16} ${cx + 5},${by - 24} L${cx - 1},${by - 1}`, class: 'stroke', 'stroke-width': 2.4 }, g);
  } else {
    el('circle', { cx: cx - 1, cy: by - 25, r: 3.2, class: 'ink' }, g);
    el('circle', { cx: cx - 4, cy: by - 15, r: 3.2, class: 'ink' }, g);
    el('path', { d: `M${cx - 2},${by - 22} Q${cx + 3},${by - 19} ${cx + 7},${by - 27} L${cx - 2},${by + 5}`, class: 'stroke', 'stroke-width': 2.4 }, g);
    el('path', { d: `M${cx - 5},${by - 12} Q${cx},${by - 9} ${cx + 4},${by - 16}`, class: 'stroke', 'stroke-width': 2.2 }, g);
  }
}

function drawFlag(g, sx, top, n) {
  for (let k = 0; k < n; k++) {
    const y = top + k * 9;
    el('path', {
      d: `M${sx},${y} C${sx + 2},${y + 8} ${sx + 13},${y + 9} ${sx + 9},${y + 22} C${sx + 10},${y + 12} ${sx + 3},${y + 12} ${sx},${y + 10} Z`,
      class: 'ink', 'stroke-width': 0.6,
    }, g);
  }
}

function drawCell(g, hand, row, cell) {
  const by = baseY(row);
  const x0 = COL_X[hand] + NOTE_X0;
  const tokens = parseCell(cell);
  const notes = tokens.filter((t) => t.type === 'note');
  const top = by - STEM;

  for (const t of tokens) {
    const x = x0 + t.slot * SP;
    if (t.type === 'rest') { drawRest(g, x, by, t.dur); continue; }
    const head = el('ellipse', {
      cx: x, cy: by, rx: 7.2, ry: 5.2, transform: `rotate(-22 ${x} ${by})`, class: 'nh',
    }, g);
    noteEls[hand].push({ beat: row, slot: t.slot, el: head });
    const sx = x + 6.2;
    el('line', { x1: sx, y1: by - 2, x2: sx, y2: top, class: 'stroke', 'stroke-width': 2 }, g);
    if (t.dur === 3) el('circle', { cx: x + 13, cy: by + 1, r: 2.4, class: 'ink' }, g);
  }

  const short = notes.filter((n) => n.dur < 4);
  const sxOf = (n) => x0 + n.slot * SP + 6.2;
  if (short.length === 1) {
    const n = short[0];
    drawFlag(g, sxOf(n), top, n.dur === 1 ? 2 : 1);
  } else if (short.length >= 2) {
    const first = short[0], last = short[short.length - 1];
    el('rect', { x: sxOf(first) - 1, y: top, width: sxOf(last) - sxOf(first) + 2, height: 5, class: 'ink', 'stroke-width': 0 }, g);
    const joined = new Set();
    for (let i = 0; i < short.length - 1; i++) {
      const a = short[i], b = short[i + 1];
      if (a.dur === 1 && b.dur === 1) {
        joined.add(a); joined.add(b);
        el('rect', { x: sxOf(a) - 1, y: top + 9, width: sxOf(b) - sxOf(a) + 2, height: 5, class: 'ink', 'stroke-width': 0 }, g);
      }
    }
    short.forEach((n, i) => {
      if (n.dur !== 1 || joined.has(n)) return;
      const len = 11;
      const x = i === 0 ? sxOf(n) - 1 : sxOf(n) - len + 1;
      el('rect', { x, y: top + 9, width: len, height: 5, class: 'ink', 'stroke-width': 0 }, g);
    });
  }
}

function renderScore() {
  const host = document.getElementById('score');
  host.innerHTML = '';
  rows = problem.L.cells.length;
  const H = svgH();
  svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  host.appendChild(svg);
  noteEls = { L: [], R: [] };
  rowHl = [];
  playheads = { L: null, R: null };
  colGroups = {};

  for (let r = 0; r < rows; r++) {
    rowHl.push(el('rect', { x: 0, y: HEADER + r * ROWH, width: W, height: ROWH, class: 'row-hl' }, svg));
  }
  // 4拍ごとの区切り線
  for (let r = 4; r < rows; r += 4) {
    const y = HEADER + r * ROWH;
    el('line', { x1: 6, y1: y, x2: W - 6, y2: y, class: 'bar-sep' }, svg);
  }
  el('line', { x1: COLW, y1: 8, x2: COLW, y2: H - 6, stroke: '#333', 'stroke-width': 1.3 }, svg);

  for (const hand of HANDS) {
    const g = el('g', {}, svg);
    colGroups[hand] = g;
    const t = el('text', { x: COL_X[hand] + COLW / 2, y: 23, 'text-anchor': 'middle', class: 'lbl' }, g);
    t.textContent = hand === 'L' ? '左手' : '右手';
    for (let r = 0; r < rows; r++) {
      if (hand === 'L') {
        const n = el('text', { x: 10, y: baseY(r) - 12, class: 'rownum' }, g);
        n.textContent = r + 1;
      }
      drawCell(g, hand, r, problem[hand].cells[r]);
    }
    playheads[hand] = el('line', { x1: 0, y1: 0, x2: 0, y2: 0, class: 'playhead' }, svg);
  }
  applyHandMode();
}

function applyHandMode() {
  if (!colGroups) return;
  for (const hand of HANDS) {
    const active = isHandActive(hand);
    colGroups[hand].classList.toggle('col-dim', !active);
    document.getElementById(hand === 'L' ? 'padL' : 'padR').classList.toggle('disabled', !active);
  }
}
const isHandActive = (hand) => settings.handMode === 'both' || settings.handMode === hand;

function clearNoteMarks() {
  for (const hand of HANDS) for (const n of noteEls[hand]) n.el.classList.remove('perfect', 'good', 'miss', 'active');
}

/* ============================================================
 * スケジューラ
 * ============================================================ */
const LOOKAHEAD = 0.12;
let mode = 'idle'; // idle | metronome | demo | challenge
let timer = null;
let raf = null;
let metro = null;  // { next, count }
let run = null;    // デモ / チャレンジの状態

const beatDur = () => 60 / settings.bpm;

function startTimer(fn) {
  stopTimer();
  fn();
  timer = setInterval(fn, 25);
}
function stopTimer() { if (timer) clearInterval(timer); timer = null; }

function stopAll() {
  stopTimer();
  if (raf) cancelAnimationFrame(raf);
  raf = null;
  mode = 'idle';
  metro = null;
  run = null;
  rowHl && rowHl.forEach((r) => r.classList.remove('on'));
  if (playheads) HANDS.forEach((h) => playheads[h].classList.remove('on'));
  if (noteEls) HANDS.forEach((h) => noteEls[h].forEach((n) => n.el.classList.remove('active')));
  document.getElementById('countdown').hidden = true;
  updateButtons();
}

function startMetronome() {
  ensureAudio();
  stopAll();
  mode = 'metronome';
  metro = { next: ctx.currentTime + 0.08, count: 0 };
  startTimer(() => {
    while (metro.next < ctx.currentTime + LOOKAHEAD) {
      const sub = settings.subdiv;
      const c = metro.count % (4 * sub);
      click(metro.next, c === 0 ? 0 : c % sub === 0 ? 1 : 2);
      metro.next += beatDur() / sub;
      metro.count++;
    }
  });
  updateButtons();
}

// デモ・チャレンジ共通: カウントイン1小節 + 本番1小節
function startRun(kind) {
  ensureAudio();
  stopAll();
  hideResult();
  clearNoteMarks();
  mode = kind;
  const b = beatDur();
  const sixteenth = b / 4;
  const t0 = ctx.currentTime + 0.15 + 4 * b; // 本番の1拍目
  const events = [];
  // カウントイン
  const nBeats = rows;
  for (let i = 0; i < 4; i++) events.push({ t: t0 - (4 - i) * b, fn: (t) => click(t, i === 0 ? 0 : 1) });
  // 本番中のメトロノーム
  if (kind === 'demo' || settings.metroInPlay) {
    const sub = settings.subdiv;
    for (let i = 0; i < nBeats * sub; i++) {
      events.push({ t: t0 + i * (b / sub), fn: (t) => click(t, i % (4 * sub) === 0 ? 0 : i % sub === 0 ? 1 : 2) });
    }
  }
  // 正解ノート
  const notes = { L: [], R: [] };
  for (const hand of HANDS) {
    if (!isHandActive(hand)) continue;
    noteEls[hand].forEach((n) => {
      notes[hand].push({ t: t0 + (n.beat + n.slot / 4) * b, el: n.el, judged: null, dev: null });
    });
    notes[hand].sort((a, c) => a.t - c.t);
    if (kind === 'demo' || settings.guide) {
      for (const n of notes[hand]) events.push({ t: n.t, fn: (t) => handSound(t, hand, kind === 'demo' ? 0.7 : 0.35) });
    }
  }
  events.sort((a, c) => a.t - c.t);

  run = {
    kind, t0, b, events, idx: 0, notes,
    perfectWin: Math.min(0.05, sixteenth * 0.4),
    goodWin: Math.min(0.12, sixteenth * 0.5),
    extra: { L: 0, R: 0 },
    end: t0 + nBeats * b,
    nBeats,
    curRow: -1,
  };
  scrollToRow(0);

  startTimer(() => {
    if (!run) return;
    while (run.idx < run.events.length && run.events[run.idx].t < ctx.currentTime + LOOKAHEAD) {
      const e = run.events[run.idx++];
      e.fn(e.t);
    }
  });
  raf = requestAnimationFrame(frame);
  updateButtons();
}

// いま叩いている段と次の段が画面に入るようにスクロール
function scrollToRow(r) {
  if (!rowHl[r]) return;
  const topLimit = 8;
  const bottomLimit = document.querySelector('.pads').getBoundingClientRect().top - 8;
  const cur = rowHl[r].getBoundingClientRect();
  const next = rowHl[Math.min(r + 1, rows - 1)].getBoundingClientRect();
  if (cur.top < topLimit || next.bottom > bottomLimit) {
    window.scrollBy({ top: cur.top - topLimit - 4, behavior: 'smooth' });
  }
}

function frame() {
  if (!run) return;
  const now = heardNow();
  const jnow = now - settings.offset / 1000; // 判定用の時刻(補正込み)
  const { t0, b } = run;
  const cd = document.getElementById('countdown');
  if (now < t0) {
    const k = Math.floor((now - (t0 - 4 * b)) / b);
    cd.hidden = k < 0;
    cd.textContent = String(Math.max(1, k + 1));
  } else {
    cd.hidden = true;
  }
  const pos = (now - t0) / b; // 本番内の拍位置
  for (let r = 0; r < rows; r++) rowHl[r].classList.toggle('on', pos >= r && pos < r + 1);
  const curRow = Math.floor(pos);
  if (curRow !== run.curRow && curRow >= 0 && curRow < run.nBeats) {
    run.curRow = curRow;
    scrollToRow(curRow);
  }
  for (const hand of HANDS) {
    const ph = playheads[hand];
    if (pos >= 0 && pos < run.nBeats) {
      const r = Math.floor(pos);
      const x = COL_X[hand] + NOTE_X0 - 10 + (pos - r) * 4 * SP;
      ph.setAttribute('x1', x); ph.setAttribute('x2', x);
      ph.setAttribute('y1', HEADER + r * ROWH + 6); ph.setAttribute('y2', HEADER + (r + 1) * ROWH - 6);
      ph.classList.add('on');
    } else ph.classList.remove('on');
  }
  for (const hand of HANDS) {
    for (const n of run.notes[hand]) {
      if (run.kind === 'demo') {
        n.el.classList.toggle('active', now >= n.t && now < n.t + Math.min(0.15, b / 4 * 0.9));
      } else if (!n.judged && jnow > n.t + run.goodWin) {
        n.judged = 'miss';
        n.el.classList.add('miss');
      }
    }
  }
  if (Math.min(now, jnow) > run.end + 0.3) {
    const finished = run;
    stopAll();
    if (finished.kind === 'challenge') showResult(finished);
    return;
  }
  raf = requestAnimationFrame(frame);
}

/* ============================================================
 * 入力と判定
 * ============================================================ */
function tap(hand, ev) {
  if (!isHandActive(hand)) return;
  ensureAudio();
  if (settings.tapSound) handSound(ctx.currentTime, hand, 0.6);
  const pad = document.getElementById(hand === 'L' ? 'padL' : 'padR');
  pad.classList.add('hit');
  setTimeout(() => pad.classList.remove('hit'), 80);

  if (mode !== 'challenge' || !run) return;
  const t = audioTimeOfEvent(ev);
  if (t < run.t0 - run.goodWin * 2 || t > run.end + run.goodWin) return; // 範囲外は無視
  let best = null;
  for (const n of run.notes[hand]) {
    if (n.judged) continue;
    const d = Math.abs(t - n.t);
    if (d <= run.goodWin && (!best || d < Math.abs(t - best.t))) best = n;
  }
  if (!best) { run.extra[hand]++; return; }
  best.dev = t - best.t;
  best.judged = Math.abs(best.dev) <= run.perfectWin ? 'perfect' : 'good';
  best.el.classList.add(best.judged);
}

function bindPad(id, hand) {
  const pad = document.getElementById(id);
  pad.addEventListener('pointerdown', (e) => { e.preventDefault(); tap(hand, e); });
  pad.addEventListener('contextmenu', (e) => e.preventDefault());
}
bindPad('padL', 'L');
bindPad('padR', 'R');

const KEYMAP = { KeyF: 'L', KeyD: 'L', KeyS: 'L', KeyJ: 'R', KeyK: 'R', KeyL: 'R' };
window.addEventListener('keydown', (e) => {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  const hand = KEYMAP[e.code];
  if (hand) { e.preventDefault(); tap(hand, e); }
});

/* ============================================================
 * 結果
 * ============================================================ */
function hideResult() {
  const r = document.getElementById('result');
  r.hidden = true;
  r.innerHTML = '';
}

function showResult(res) {
  const stats = {};
  const devs = [];
  let total = 0, points = 0;
  for (const hand of HANDS) {
    const s = { perfect: 0, good: 0, miss: 0, extra: res.extra[hand], n: res.notes[hand].length };
    for (const n of res.notes[hand]) {
      const j = n.judged || 'miss';
      s[j]++;
      if (n.dev !== null) devs.push(n.dev);
    }
    stats[hand] = s;
    total += s.n;
    points += s.perfect * 100 + s.good * 60 - s.extra * 30;
  }
  const score = total ? Math.max(0, Math.round(points / total)) : 0;
  const rank = score >= 95 ? 'S' : score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : 'D';
  const rankColor = { S: '#eab308', A: '#16a34a', B: '#2563eb', C: '#d97706', D: '#dc2626' }[rank];
  const mean = devs.length ? devs.reduce((a, c) => a + c, 0) / devs.length * 1000 : null;

  const cell = (hand, key) => isHandActive(hand) ? stats[hand][key] : '—';
  const r = document.getElementById('result');
  r.innerHTML = `
    <div class="head">
      <div class="rank" style="color:${rankColor}">${rank}</div>
      <div class="score">${score} 点</div>
    </div>
    <div class="rows">
      <div class="h"></div><div class="h">左手</div><div class="h">右手</div>
      <div class="c-perfect">Perfect</div><div>${cell('L', 'perfect')}</div><div>${cell('R', 'perfect')}</div>
      <div class="c-good">Good</div><div>${cell('L', 'good')}</div><div>${cell('R', 'good')}</div>
      <div class="c-miss">Miss</div><div>${cell('L', 'miss')}</div><div>${cell('R', 'miss')}</div>
      <div>余分な打鍵</div><div>${cell('L', 'extra')}</div><div>${cell('R', 'extra')}</div>
    </div>
    <div class="dev">${mean === null ? '' : `平均のズレ: ${mean >= 0 ? '+' : ''}${mean.toFixed(0)} ms(${Math.abs(mean) < 10 ? 'ぴったり' : mean > 0 ? '遅め' : '早め'})`}</div>
    <div class="legend"><i style="background:var(--perfect)"></i>Perfect<i style="background:var(--good)"></i>Good<i style="background:var(--miss)"></i>Miss</div>
    <div class="actions">
      <button class="btn" id="resRetry">もう一度</button>
      <button class="btn" id="resNext">次の問題</button>
      ${mean !== null && Math.abs(mean) >= 10 ? '<button class="btn" id="resCalib">ズレを補正に反映</button>' : ''}
    </div>`;
  r.hidden = false;
  document.getElementById('resRetry').onclick = () => startRun('challenge');
  document.getElementById('resNext').onclick = () => { newProblem(); startRun('challenge'); };
  const calib = document.getElementById('resCalib');
  if (calib) calib.onclick = () => {
    setOffset(Math.round((settings.offset + mean) / 5) * 5);
    calib.remove();
  };
}

/* ============================================================
 * UI
 * ============================================================ */
const $ = (id) => document.getElementById(id);

function setBpm(v) {
  settings.bpm = Math.max(30, Math.min(240, Math.round(v)));
  $('bpmValue').textContent = settings.bpm;
  $('bpmSlider').value = settings.bpm;
  saveSettings();
}
function setOffset(v) {
  settings.offset = Math.max(-200, Math.min(200, v));
  $('offset').value = settings.offset;
  $('offsetValue').textContent = (settings.offset > 0 ? '+' : '') + settings.offset;
  saveSettings();
}

function updateButtons() {
  const running = mode === 'demo' || mode === 'challenge';
  $('btnMetro').classList.toggle('on', mode === 'metronome');
  $('btnMetro').textContent = mode === 'metronome' ? '⏹ メトロノーム停止' : '🕒 メトロノーム';
  $('btnDemo').textContent = mode === 'demo' ? '⏹ 停止' : '🔊 お手本';
  $('btnChallenge').textContent = mode === 'challenge' ? '⏹ 停止' : '▶ チャレンジ';
  $('btnDemo').disabled = mode === 'challenge';
  $('btnChallenge').disabled = mode === 'demo';
  $('btnNew').disabled = running;
  document.querySelectorAll('[data-bpm]').forEach((b) => (b.disabled = running));
  $('bpmSlider').disabled = running;
  $('handMode').disabled = running;
  $('beats').disabled = running;
}

document.querySelectorAll('[data-bpm]').forEach((b) => {
  b.addEventListener('click', () => setBpm(settings.bpm + Number(b.dataset.bpm)));
});
$('bpmSlider').addEventListener('input', (e) => setBpm(Number(e.target.value)));
$('btnNew').addEventListener('click', () => newProblem());
$('btnMetro').addEventListener('click', () => (mode === 'metronome' ? stopAll() : startMetronome()));
$('btnDemo').addEventListener('click', () => (mode === 'demo' ? stopAll() : startRun('demo')));
$('btnChallenge').addEventListener('click', () => (mode === 'challenge' ? stopAll() : startRun('challenge')));

const beatsSel = $('beats');
for (let n = 4; n <= 20; n++) beatsSel.add(new Option(`${n}拍`, String(n)));
settings.beats = Math.max(4, Math.min(20, Number(settings.beats) || 4));
beatsSel.value = String(settings.beats);
beatsSel.addEventListener('change', (e) => { settings.beats = Number(e.target.value); saveSettings(); newProblem(); });

$('handMode').value = settings.handMode;
$('handMode').addEventListener('change', (e) => { settings.handMode = e.target.value; saveSettings(); applyHandMode(); });
$('subdiv').value = String(settings.subdiv);
$('subdiv').addEventListener('change', (e) => {
  settings.subdiv = Number(e.target.value); saveSettings();
  if (metro) metro.count = 0; // 刻みを変えたら小節頭から数え直す
});
for (const key of ['metroInPlay', 'guide', 'tapSound']) {
  $(key).checked = settings[key];
  $(key).addEventListener('change', (e) => { settings[key] = e.target.checked; saveSettings(); });
}
$('volume').value = settings.volume;
$('volume').addEventListener('input', (e) => {
  settings.volume = Number(e.target.value); saveSettings();
  if (master) master.gain.value = settings.volume;
});
$('offset').addEventListener('input', (e) => setOffset(Number(e.target.value)));

// ボタンにフォーカスが残ってスペース/Enterで誤作動しないように
document.querySelectorAll('button').forEach((b) => b.addEventListener('mouseup', () => b.blur()));
document.addEventListener('visibilitychange', () => { if (document.hidden && mode !== 'idle') stopAll(); });

setBpm(settings.bpm);
setOffset(settings.offset);
newProblem();
updateButtons();

// デバッグ用: 任意の拍の組み合わせを表示する
window.__rhythm = {
  show(L, R) {
    problem = { L: { ids: [], cells: L }, R: { ids: [], cells: R } };
    renderScore();
  },
  state: () => ({ run, ctx }),
};
