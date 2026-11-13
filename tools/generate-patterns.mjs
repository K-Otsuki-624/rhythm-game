// 1拍ぶんのリズム(16分音符グリッド)を組み合わせて、右手・左手それぞれ100パターンの
// 4拍フレーズを生成し、patterns.js に書き出すスクリプト。
//   node tools/generate-patterns.mjs
//
// 1拍の表記: 4文字(16分音符ひとつ = 1文字)
//   x = 音の頭(打つ)  - = 前の音の伸ばし  . = 休符
// 使う音価: 4分・付点8分・8分・16分音符 / 8分・16分休符(4分休符 "...." は使わない)
// 休符は拍の頭にだけ置く(音のあとに休符は入れず、次の音まで伸ばして書く)

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

function allCells() {
  const out = [];
  const rec = (s) => {
    if (s.length === 4) { if (s !== '....') out.push(s); return; }
    // 休符は拍の頭(最初の音より前)だけ。音のあとの休符は音を伸ばす形にする
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
};
// 出やすさ: 頭からリズムがある型を多めに(頭に休符がある拍は全体の2割強)
const weightOf = (c) => (c[0] === '.' ? 1 : 3);
const diffOf = (p) => p.reduce((a, c) => a + DIFFICULTY[c], 0);
const restsOf = (p) => p.filter((c) => c[0] === '.').length;

function pickWeighted(cells, rnd) {
  const total = cells.reduce((a, c) => a + weightOf(c), 0);
  let r = rnd() * total;
  for (const c of cells) { r -= weightOf(c); if (r < 0) return c; }
  return cells[cells.length - 1];
}

function okPattern(p) {
  const counts = {};
  p.forEach((c) => (counts[c] = (counts[c] || 0) + 1));
  if (Object.values(counts).some((n) => n >= 3)) return false; // 同じ拍が3回以上は単調
  if (restsOf(p) > 2) return false;                            // 頭休符の拍は1パターン2つまで
  return true;
}

// 左手: 重み付きランダムで100パターン
function generateLeft(seed, count) {
  const cells = allCells();
  const rnd = mulberry32(seed);
  const seen = new Set();
  const list = [];
  while (list.length < count) {
    const p = Array.from({ length: 4 }, () => pickWeighted(cells, rnd));
    const key = p.join('|');
    if (!okPattern(p) || seen.has(key)) continue;
    seen.add(key);
    list.push(p);
  }
  return list;
}

// 右手: 左手の各パターンと「難しさ合計」「頭休符の数」が同じものを1つずつ作る
// → 左右で難易度の分布がそろう
function generateRight(seed, left) {
  const cells = allCells();
  const rnd = mulberry32(seed);
  const seen = new Set(left.map((p) => p.join('|')));
  return left.map((lp) => {
    for (;;) {
      const p = Array.from({ length: 4 }, () => pickWeighted(cells, rnd));
      const key = p.join('|');
      if (!okPattern(p) || seen.has(key)) continue;
      if (diffOf(p) !== diffOf(lp) || restsOf(p) !== restsOf(lp)) continue;
      seen.add(key);
      return p;
    }
  });
}

const cells = allCells();
const left = generateLeft(4242, 100);
const right = generateRight(20261113, left);

const fmt = (arr) => arr.map((p) => `  [${p.map((c) => `'${c}'`).join(', ')}]`).join(',\n');
const out = `// このファイルは tools/generate-patterns.mjs で自動生成されています。
// 1拍 = 4文字(16分音符グリッド): x = 打つ / - = 伸ばす / . = 休符
// 1拍の型は全${cells.length}種類: ${cells.join(' ')}

export const RIGHT_PATTERNS = [
${fmt(right)}
];

export const LEFT_PATTERNS = [
${fmt(left)}
];

// 1拍の型ごとの難しさ(出題時に左右の難易度をそろえるのに使う)
export const CELL_DIFFICULTY = ${JSON.stringify(DIFFICULTY)};
`;
const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(here, '..', 'patterns.js'), out);
console.log(`cells=${cells.length} right=${right.length} left=${left.length}`);
