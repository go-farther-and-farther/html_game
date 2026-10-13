/* 5×5 加难度方案对比：固定 awds 循环 vs 随机按键，看每种改法的分数 */
const SIZE = 5;
const KEY = { a: 'left', s: 'down', d: 'right', w: 'up' };

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeGrid() { return Array.from({ length: SIZE }, () => Array(SIZE).fill(0)); }
function emptyCells(g) { const a = []; for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (!g[r][c]) a.push({ r, c }); return a; }
function slide(row, st) {
  let arr = row.filter(v => v);
  for (let i = 0; i < arr.length - 1; i++) if (arr[i] === arr[i + 1]) { arr[i] *= 2; st.score += arr[i]; arr.splice(i + 1, 1); if (arr[i] === 2048) st.won = true; }
  while (arr.length < SIZE) arr.push(0);
  return arr;
}
function move(g, d, st) {
  let moved = false; const old = g.map(r => [...r]);
  if (d === 'left') { for (let r = 0; r < SIZE; r++) g[r] = slide(g[r], st); }
  else if (d === 'right') { for (let r = 0; r < SIZE; r++) g[r] = slide(g[r].slice().reverse(), st).reverse(); }
  else if (d === 'up') { for (let c = 0; c < SIZE; c++) { let col = []; for (let r = 0; r < SIZE; r++) col.push(g[r][c]); col = slide(col, st); for (let r = 0; r < SIZE; r++) g[r][c] = col[r]; } }
  else { for (let c = 0; c < SIZE; c++) { let col = []; for (let r = 0; r < SIZE; r++) col.push(g[r][c]); col = slide(col.slice().reverse(), st).reverse(); for (let r = 0; r < SIZE; r++) g[r][c] = col[r]; } }
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (g[r][c] !== old[r][c]) moved = true;
  if (moved) for (let k = 0; k < st.spawn; k++) {
    const cells = emptyCells(g); if (!cells.length) break;
    const { r, c } = cells[Math.floor(st.rng() * cells.length)];
    g[r][c] = st.pick(st.rng);
  }
  return moved;
}
function canMove(g) { for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) { if (!g[r][c]) return true; if (c < SIZE - 1 && g[r][c] === g[r][c + 1]) return true; if (r < SIZE - 1 && g[r][c] === g[r + 1][c]) return true; } return false; }

const MODES = {
  '原版 (1个方块, 90%出2)':            { spawn: 1, pick: r => r() < 0.9 ? 2 : 4 },
  '每步出2个方块':                     { spawn: 2, pick: r => r() < 0.9 ? 2 : 4 },
  '每步出3个方块':                     { spawn: 3, pick: r => r() < 0.9 ? 2 : 4 },
  '每步1个, 50%出4':                   { spawn: 1, pick: r => r() < 0.5 ? 2 : 4 },
  '每步1个, 2/4/8各1/3':               { spawn: 1, pick: r => [2, 4, 8][Math.floor(r() * 3)] },
  '每步1个, 必出4':                    { spawn: 1, pick: () => 4 },
  '每步2个, 2/4/8各1/3':              { spawn: 2, pick: r => [2, 4, 8][Math.floor(r() * 3)] },
  '每步1个 + 每10步额外1个(累计)':     { spawn: 1, pick: r => r() < 0.9 ? 2 : 4, extra: 10 },
};

function play(cycle, mode, seed, cap = 200000) {
  const rng = mulberry32(seed);
  const grid = makeGrid();
  const st = { score: 0, won: false, rng, spawn: mode.spawn, pick: mode.pick };
  for (let k = 0; k < mode.spawn + 1; k++) { const c = emptyCells(grid); const { r, c: cc } = c[Math.floor(rng() * c.length)]; grid[r][cc] = mode.pick(rng); }
  let i = 0, moves = 0;
  while (i < cap) {
    move(grid, cycle[i % cycle.length], st);
    if (mode.extra && i % mode.extra === mode.extra - 1) { const c = emptyCells(grid); if (c.length) { const { r, c: cc } = c[Math.floor(rng() * c.length)]; grid[r][cc] = mode.pick(rng); } }
    moves++; i++;
    if (!canMove(grid)) break;
  }
  let mt = 0; for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) mt = Math.max(mt, grid[r][c]);
  return { score: st.score, maxTile: mt, moves, won: st.won };
}
function rep(label, res) {
  const s = res.map(r => r.score).sort((a, b) => a - b); const n = s.length, q = p => s[Math.min(n - 1, Math.floor(p * n))];
  console.log(`${label.padEnd(34)} 平均 ${String(Math.round(s.reduce((a, b) => a + b, 0) / n)).padStart(7)}  中位 ${String(q(0.5)).padStart(7)}  最高 ${String(s[n - 1]).padStart(8)}  达2048 ${(res.filter(r => r.won).length / n * 100).toFixed(1).padStart(5)}%  平均步数 ${String(Math.round(res.reduce((a, r) => a + r.moves, 0) / n)).padStart(6)}`);
}
const N = 600;
const awds = ['left', 'up', 'right', 'down'];
console.log('=== 5×5 固定 awds 循环 ===');
for (const [name, mode] of Object.entries(MODES)) rep(name, Array.from({ length: N }, (_, k) => play(awds, mode, 31000 + k)));
console.log('\n=== 5×5 随机按键（对照：完全不会玩的水平） ===');
for (const [name, mode] of Object.entries(MODES)) {
  rep(name, Array.from({ length: N }, (_, k) => {
    const rng = mulberry32(41000 + k);
    const grid = makeGrid(); const st = { score: 0, won: false, rng, spawn: mode.spawn, pick: mode.pick };
    for (let i = 0; i < mode.spawn + 1; i++) { const c = emptyCells(grid); const { r, c: cc } = c[Math.floor(rng() * c.length)]; grid[r][cc] = mode.pick(rng); }
    const dirs = ['left', 'up', 'right', 'down']; let moves = 0;
    while (moves < 200000) {
      move(grid, dirs[Math.floor(rng() * 4)], st);
      if (mode.extra && moves % mode.extra === mode.extra - 1) { const c = emptyCells(grid); if (c.length) { const { r, c: cc } = c[Math.floor(rng() * c.length)]; grid[r][cc] = mode.pick(rng); } }
      moves++; if (!canMove(grid)) break;
    }
    let mt = 0; for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) mt = Math.max(mt, grid[r][c]);
    return { score: st.score, maxTile: mt, moves, won: st.won };
  }));
}
