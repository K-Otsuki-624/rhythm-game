// 1拍ぶんのリズムを組み合わせて、右手・左手それぞれ100パターンの4拍フレーズを
// 「休符あり/なし」×「三連符あり/なし」の4セットぶん生成し、patterns.js に書き出す。
//   node tools/generate-patterns.mjs
//
// 1拍の表記
//   4文字 = 16分音符グリッド(1文字 = 16分音符ひとつ)
//   3文字 = 8分三連符グリッド(1文字 = 三連符の8分ひとつ)
//   x = 音の頭(打つ)  - = 前の音の伸ばし  . = 休符
// 使う音価: 4分・付点8分・8分・16分音符 / 8分・16分休符(4分休符は使わない)、8分三連符
// 休符は拍の頭にだけ置く(音のあとに休符は入れず、次の音まで伸ばして書く)
// ただし8分三連符は「8分3つ」だけで、3つの中のどこに休符が入ってもよい

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// 16分音符グリッドの1拍(全15種類)
function sixteenthCells() {
  const out = [];
  const rec = (s) => {
    if (s.length === 4) { if (s !== '....') out.push(s); return; }
    const started = s.includes('x');
    for (const c of ['x', '-', '.']) {
      if (c === '-' && !(s.endsWith('x') || s.endsWith('-'))) continue;
      if (c === '.' && started) continue;
      rec(s + c);
    }
  };
  rec('');
  return out;
}
// 8分三連符の1拍: 8分3つ(どこに休符が入ってもOK。伸ばす形は使わない)
const TRIPLET_CELLS = ['xxx', 'xx.', 'x.x', 'x..', '.xx', '.x.', '..x'];

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 1拍の型ごとの難しさ(目安)
const DIFFICULTY = {
  'x---': 1, 'x-x-': 1, 'x--x': 2, 'xxxx': 2, 'x-xx': 2, 'xxx-': 2, 'xx--': 3, 'xx-x': 3,
  '..x-': 2, '..xx': 3, '.xxx': 3, '...x': 4, '.x-x': 4, '.x--': 4, '.xx-': 4,
  'xxx': 2, 'xx.': 3, 'x.x': 3, 'x..': 3, '.xx': 4, '.x.': 4, '..x': 4,
};
const isRest = (c) => c.includes('.');
const isTriplet = (c) => c.length === 3;
// 出やすさ: 頭からリズムがある型を多めに。三連符は1パターンに1〜2拍くらい
const weightOf = (c) => {
  if (isTriplet(c)) return c === 'xxx' ? 3 : 0.5; // 三連符は8分3つを中心に、休符入りは少なめ
  return isRest(c) ? 1 : 3;
};
const diffOf = (p) => p.reduce((a, c) => a + DIFFICULTY[c], 0);
const restsOf = (p) => p.filter(isRest).length;
const tripletsOf = (p) => p.filter(isTriplet).length;

function pickWeighted(cells, rnd) {
  const total = cells.reduce((a, c) => a + weightOf(c), 0);
  let r = rnd() * total;
  for (const c of cells) { r -= weightOf(c); if (r < 0) return c; }
  return cells[cells.length - 1];
}

function okPattern(p, triplet) {
  const counts = {};
  p.forEach((c) => (counts[c] = (counts[c] || 0) + 1));
  if (Object.values(counts).some((n) => n >= 3)) return false; // 同じ拍が3回以上は単調
  if (restsOf(p) > 2) return false;                            // 休符入りの拍は1パターン2つまで
  if (triplet && (tripletsOf(p) < 1 || tripletsOf(p) > 2)) return false; // 三連符は1〜2拍
  return true;
}

// 左手: 重み付きランダムで100パターン
function generateLeft(cells, triplet, seed, count) {
  const rnd = mulberry32(seed);
  const seen = new Set();
  const list = [];
  while (list.length < count) {
    const p = Array.from({ length: 4 }, () => pickWeighted(cells, rnd));
    const key = p.join('|');
    if (!okPattern(p, triplet) || seen.has(key)) continue;
    seen.add(key);
    list.push(p);
  }
  return list;
}

// 右手: 左手の各パターンと「難しさ合計」「休符入りの拍の数」「三連符の数」が同じものを作る
// → 左右で難易度の分布がそろう
function generateRight(cells, triplet, seed, left) {
  const rnd = mulberry32(seed);
  const seen = new Set(left.map((p) => p.join('|')));
  return left.map((lp) => {
    for (;;) {
      const p = Array.from({ length: 4 }, () => pickWeighted(cells, rnd));
      const key = p.join('|');
      if (!okPattern(p, triplet) || seen.has(key)) continue;
      if (diffOf(p) !== diffOf(lp) || restsOf(p) !== restsOf(lp) || tripletsOf(p) !== tripletsOf(lp)) continue;
      seen.add(key);
      return p;
    }
  });
}

const base = sixteenthCells();
const SETS = {
  // 休符あり・三連符なし(従来のパターン。シードも従来どおり)
  rest: { cells: base, triplet: false, seedL: 4242, seedR: 20261113 },
  norest: { cells: base.filter((c) => !isRest(c)), triplet: false, seedL: 777, seedR: 31337 },
  rest_triplet: { cells: [...base, ...TRIPLET_CELLS], triplet: true, seedL: 1234, seedR: 5678 },
  norest_triplet: { cells: [...base, ...TRIPLET_CELLS].filter((c) => !isRest(c)), triplet: true, seedL: 2468, seedR: 1357 },
};

const fmt = (arr) => arr.map((p) => `      [${p.map((c) => `'${c}'`).join(', ')}]`).join(',\n');
let body = '';
for (const [name, cfg] of Object.entries(SETS)) {
  const L = generateLeft(cfg.cells, cfg.triplet, cfg.seedL, 100);
  const R = generateRight(cfg.cells, cfg.triplet, cfg.seedR, L);
  body += `  ${name}: {\n    L: [\n${fmt(L)},\n    ],\n    R: [\n${fmt(R)},\n    ],\n  },\n`;
  console.log(`${name}: cells=${cfg.cells.length} L=${L.length} R=${R.length}`);
}

const out = `// このファイルは tools/generate-patterns.mjs で自動生成されています。
// 1拍 = 4文字(16分音符グリッド) または 3文字(8分三連符グリッド)
//   x = 打つ / - = 伸ばす / . = 休符(休符は拍の頭だけ)
// セット: rest = 休符あり, norest = 休符なし, *_triplet = 三連符あり

export const PATTERNS = {
${body}};

// 1拍の型ごとの難しさ(出題時に左右の難易度をそろえるのに使う)
export const CELL_DIFFICULTY = ${JSON.stringify(DIFFICULTY)};
`;
const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(here, '..', 'patterns.js'), out);
