// 1拍ぶんのリズム(16分音符グリッド)を組み合わせて、右手・左手それぞれ100パターンの
// 4拍フレーズを生成し、patterns.js に書き出すスクリプト。
//   node tools/generate-patterns.mjs
//
// 1拍の表記: 4文字(16分音符ひとつ = 1文字)
//   x = 音の頭(打つ)  - = 前の音の伸ばし  . = 休符
// 使う音価: 4分・付点8分・8分・16分音符 / 8分・16分休符(4分休符 "...." は使わない)

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

function allCells() {
  const out = [];
  const rec = (s) => {
    if (s.length === 4) { if (s !== '....') out.push(s); return; }
    for (const c of ['x', '-', '.']) {
      if (c === '-' && !(s.endsWith('x') || s.endsWith('-'))) continue;
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

function generate(seed, count) {
  const cells = allCells();
  const rnd = mulberry32(seed);
  const seen = new Set();
  const list = [];
  while (list.length < count) {
    const p = Array.from({ length: 4 }, () => cells[Math.floor(rnd() * cells.length)]);
    const key = p.join('|');
    // 同じ拍が3回以上続くものは単調なので除外
    const counts = {};
    p.forEach((c) => (counts[c] = (counts[c] || 0) + 1));
    if (Object.values(counts).some((n) => n >= 3)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(p);
  }
  return list;
}

const cells = allCells();
const right = generate(20261113, 100);
const left = generate(4242, 100);

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
`;
const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(here, '..', 'patterns.js'), out);
console.log(`cells=${cells.length} right=${right.length} left=${left.length}`);
