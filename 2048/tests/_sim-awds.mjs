/* ============================================================
   2048 固定按键循环模拟器（精确复刻 2048.html / 2048-5x5.html 的规则）
   用法:
     node _sim-awds.mjs                 # awds 循环, 5x5, 3000 局
     node _sim-awds.mjs awds 10000      # 指定循环与局数
     node _sim-awds.mjs awds 3000 5 2   # 循环 / 局数 / 棋盘边长 / 每步生成方块数
     node _sim-awds.mjs --hard 3000 2   # 复刻改难后的 2048-5x5.html（含随机按键对照）
     node _sim-awds.mjs --sizes         # 4x4 / 5x5 / 6x6 / 7x7 对比
     node _sim-awds.mjs --cycles        # 各种按键循环对比
     node _sim-awds.mjs --deadlock      # 打印"死锁"终局棋盘
   循环用字母表示: a=左 s=下 d=右 w=上
   ============================================================ */

const KEY = { a: 'left', s: 'down', d: 'right', w: 'up' };

function makeSim(SIZE, spawnPerMove = 1) {
  function makeGrid() { return Array.from({ length: SIZE }, () => Array(SIZE).fill(0)); }
  function emptyCells(g) {
    const a = [];
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (!g[r][c]) a.push({ r, c });
    return a;
  }
  function addRandomTile(g, rng) {
    const cells = emptyCells(g);
    if (!cells.length) return;
    const { r, c } = cells[Math.floor(rng() * cells.length)];
    g[r][c] = rng() < 0.9 ? 2 : 4;
  }
  function slide(row, st) {
    let arr = row.filter(v => v);
    for (let i = 0; i < arr.length - 1; i++) {
      if (arr[i] === arr[i + 1]) {
        arr[i] *= 2; st.score += arr[i]; arr.splice(i + 1, 1);
        if (arr[i] === 2048) st.won = true;
      }
    }
    while (arr.length < SIZE) arr.push(0);
    return arr;
  }
  function move(g, d, st) {
    let moved = false;
    const old = g.map(r => [...r]);
    if (d === 'left') { for (let r = 0; r < SIZE; r++) g[r] = slide(g[r], st); }
    else if (d === 'right') { for (let r = 0; r < SIZE; r++) g[r] = slide(g[r].slice().reverse(), st).reverse(); }
    else if (d === 'up') {
      for (let c = 0; c < SIZE; c++) {
        let col = []; for (let r = 0; r < SIZE; r++) col.push(g[r][c]);
        col = slide(col, st); for (let r = 0; r < SIZE; r++) g[r][c] = col[r];
      }
    } else {
      for (let c = 0; c < SIZE; c++) {
        let col = []; for (let r = 0; r < SIZE; r++) col.push(g[r][c]);
        col = slide(col.slice().reverse(), st).reverse(); for (let r = 0; r < SIZE; r++) g[r][c] = col[r];
      }
    }
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (g[r][c] !== old[r][c]) moved = true;
    if (moved) for (let k = 0; k < spawnPerMove; k++) addRandomTile(g, st.rng);   // 空操作不生成新方块（与网页一致）
    return moved;
  }
  function canMove(g) {
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
      if (!g[r][c]) return true;
      if (c < SIZE - 1 && g[r][c] === g[r][c + 1]) return true;
      if (r < SIZE - 1 && g[r][c] === g[r + 1][c]) return true;
    }
    return false;
  }
  return { SIZE, makeGrid, move, canMove, addRandomTile };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function play(SIZE, cycle, seed, cap = 400000, spawnPerMove = 1) {
  const sim = makeSim(SIZE, spawnPerMove);
  const rng = mulberry32(seed);
  const grid = sim.makeGrid();
  const st = { score: 0, won: false, rng };
  sim.addRandomTile(grid, rng); sim.addRandomTile(grid, rng);
  let i = 0, moves = 0, noops = 0;
  while (i < cap) {
    if (!sim.move(grid, cycle[i % cycle.length], st)) noops++;
    moves++; i++;
    if (!sim.canMove(grid)) break;
  }
  let maxTile = 0;
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) maxTile = Math.max(maxTile, grid[r][c]);
  // 死锁：棋盘还能走（网页不会显示"游戏结束"），但循环里的键全是空操作
  const frozen = sim.canMove(grid) && cycle.every(k => {
    const g2 = grid.map(x => [...x]);
    return !sim.move(g2, k, { score: 0, won: false, rng: mulberry32(1) });
  });
  return { score: st.score, maxTile, moves, noops, won: st.won, frozen, grid, seed };
}

function report(label, res) {
  const s = res.map(r => r.score).sort((a, b) => a - b);
  const n = s.length, q = p => s[Math.min(n - 1, Math.floor(p * n))];
  const mean = Math.round(s.reduce((a, b) => a + b, 0) / n);
  const frozen = res.filter(r => r.frozen).length;
  const pct = x => (x / n * 100).toFixed(1) + '%';
  console.log(`\n${label}  (${n} 局)`);
  console.log(`  平均 ${mean}   中位 ${q(0.5)}   最低 ${s[0]}   最高 ${s[n - 1]}`);
  console.log(`  p10=${q(0.1)}  p25=${q(0.25)}  p75=${q(0.75)}  p90=${q(0.9)}  p99=${q(0.99)}`);
  console.log(`  达2048 ${pct(res.filter(r => r.won).length)}   达4096 ${pct(res.filter(r => r.maxTile >= 4096).length)}   达8192 ${pct(res.filter(r => r.maxTile >= 8192).length)}`);
  console.log(`  平均步数 ${Math.round(res.reduce((a, r) => a + r.moves, 0) / n)}   最长 ${Math.max(...res.map(r => r.moves))}   死锁卡死 ${frozen}/${n}${frozen ? ' (分数不再增长，但游戏不结束)' : ''}`);
}

const args = process.argv.slice(2);
const parseCycle = str => [...str.toLowerCase()].map(ch => { if (!KEY[ch]) throw new Error('按键只支持 wasd: ' + str); return KEY[ch]; });

if (args[0] === '--sizes') {
  const N = parseInt(args[1] || '2000', 10);
  for (const SIZE of [4, 5, 6, 7]) report(`awds 循环 @ ${SIZE}×${SIZE}`, Array.from({ length: N }, (_, k) => play(SIZE, parseCycle('awds'), 900000 + k)));
} else if (args[0] === '--cycles') {
  const N = parseInt(args[1] || '400', 10);
  const list = { 'awds (轮转一圈)': 'awds', 'wasd (轮转一圈)': 'wasd', 'sdaw (轮转一圈)': 'sdaw', 'awad': 'awad', 'awd': 'awd', 'ad (左右左右)': 'ad', 'ws (上下上下)': 'ws', 'awdasd': 'awdasd', 'awdsawds': 'awdsawds' };
  for (const [name, c] of Object.entries(list)) report(`5×5  ${name}`, Array.from({ length: N }, (_, k) => play(5, parseCycle(c), 7000 + k)));
} else if (args[0] === '--deadlock') {
  for (const c of ['awad', 'ws', 'ad']) {
    for (const seed of [7002, 7001, 7003]) {
      const r = play(5, parseCycle(c), seed);
      if (!r.frozen) continue;
      console.log(`\n${c} seed=${seed} 分数=${r.score} 步数=${r.moves} 其中空操作 ${r.noops} 步`);
      r.grid.forEach(row => console.log('  ' + row.map(v => String(v || '.').padStart(5)).join('')));
    }
  }
} else if (args[0] === '--hard') {
  // 复刻改难之后的 2048-5x5.html：5×5 + 每步生成 2 个方块 + 开局 2 个方块
  const N = parseInt(args[1] || '3000', 10);
  const SPAWN = parseInt(args[2] || '2', 10);
  const list = { 'awds (轮转一圈)': 'awds', 'wasd (轮转一圈)': 'wasd', 'awad': 'awad', 'awdasd': 'awdasd' };
  for (const [name, c] of Object.entries(list)) report(`困难版 5×5 每步${SPAWN}块  ${name}`, Array.from({ length: N }, (_, k) => play(5, parseCycle(c), 31000 + k, 200000, SPAWN)));
  // 随机按键对照（完全不会玩的水平）
  const rnd = [];
  for (let k = 0; k < N; k++) {
    const sim = makeSim(5, SPAWN);
    const rng = mulberry32(41000 + k);
    const grid = sim.makeGrid();
    const st = { score: 0, won: false, rng };
    sim.addRandomTile(grid, rng); sim.addRandomTile(grid, rng);
    const dirs = ['left', 'up', 'right', 'down'];
    let moves = 0;
    while (moves < 200000) { sim.move(grid, dirs[Math.floor(rng() * 4)], st); moves++; if (!sim.canMove(grid)) break; }
    let mt = 0; for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) mt = Math.max(mt, grid[r][c]);
    rnd.push({ score: st.score, maxTile: mt, moves, noops: 0, won: st.won, frozen: false });
  }
  report(`困难版 5×5 每步${SPAWN}块  随机按键对照`, rnd);
} else {
  const cycle = parseCycle(args[0] || 'awds');
  const N = parseInt(args[1] || '3000', 10);
  const SIZE = parseInt(args[2] || '5', 10);
  const SPAWN = parseInt(args[3] || '1', 10);
  const res = Array.from({ length: N }, (_, k) => play(SIZE, cycle, 500000 + k, 400000, SPAWN));
  report(`${args[0] || 'awds'} 循环 @ ${SIZE}×${SIZE} 每步${SPAWN}块`, res);
  let best = null;
  for (const r of res) if (!best || r.score > best.score) best = r;
  console.log(`\n最高分局 seed=${best.seed} 分数=${best.score} 步数=${best.moves} 最大方块=${best.maxTile}`);
  best.grid.forEach(row => console.log('  ' + row.map(v => String(v || '.').padStart(6)).join('')));
}
