/* 元素哨站 V7 固定种子平衡模拟。 */
const fs = require('fs');
const ctx = new Proxy({}, { get: (_, k) => k === 'measureText' ? () => ({ width: 10 }) : k === 'createLinearGradient' || k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : () => {}, set: () => true });
const canvas = { width: 960, height: 640, style: {}, getContext: () => ctx, addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 640 }) };
const el = () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; }, appendChild() {} });
global.window = global;
global.performance = { now: () => 0 };
global.requestAnimationFrame = () => {};
global.addEventListener = () => {};
global.document = { body: el(), getElementById: id => id === 'game' ? canvas : id === 'stage' ? { clientWidth: 960, clientHeight: 640 } : el(), querySelectorAll: () => [], addEventListener() {} };
const storage = new Map();
global.localStorage = { getItem: k => storage.has(k) ? storage.get(k) : null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) };
const html = fs.readFileSync('elemental_outpostV7.html', 'utf8');
eval(html.match(/<script>([\s\S]*)<\/script>/)[1]);
const { Game, TOWERS } = global.ElementalOutpostV7;

function seeded(seed) {
  let n = seed >>> 0;
  return () => ((n = Math.imul(n ^ n >>> 15, 1 | n), n ^= n + Math.imul(n ^ n >>> 7, 61 | n), ((n ^ n >>> 14) >>> 0) / 4294967296));
}
function cellsFor(game) {
  const cells = [];
  for (let r = 0; r < 12; r++) for (let c = 0; c < 20; c++) {
    if (game.map.path.cells.has(c + ',' + r)) continue;
    let coverage = 0;
    for (let rr = 0; rr < 12; rr++) for (let cc = 0; cc < 20; cc++) {
      if (game.map.path.cells.has(cc + ',' + rr) && Math.hypot((c - cc) * 48, (r - rr) * 48) <= 92) coverage++;
    }
    cells.push({ c, r, coverage });
  }
  return cells.sort((a, b) => b.coverage - a.coverage);
}
const order = ['arrow','poison','ice','cannon','boom','laser','rail','prism','glaive','magnet','storm','hole','obelisk'];
function bot(game, cells) {
  let changed = true, guard = 0;
  while (changed && guard++ < 80) {
    changed = false;
    const owned = [...game.towers.values()];
    for (const t of owned) if (t.level === 3 && !t.spec) { t.chooseSpec(Object.keys(t.cfg.specs)[0]); changed = true; }
    let candidate = null;
    for (const t of owned) if (t.canUpgrade() && game.score >= t.upgradeCost() && (!candidate || t.upgradeCost() < candidate.upgradeCost())) candidate = t;
    const wanted = order.find(k => !owned.some(t => t.type === k));
    if (wanted && game.towers.size < game.maxTowers && game.score >= TOWERS[wanted].cost) {
      const p = cells.find(x => !game.towers.has(x.c + ',' + x.r));
      if (p) { game.buildType = wanted; changed = game.build(p.c, p.r); continue; }
    }
    if (candidate) { changed = candidate.upgrade(game); continue; }
    if (game.towers.size < game.maxTowers && game.score >= TOWERS.arrow.cost) {
      const p = cells.find(x => !game.towers.has(x.c + ',' + x.r));
      if (p) { game.buildType = owned.filter(t => t.type === 'poison').length < 3 ? 'poison' : 'arrow'; changed = game.build(p.c, p.r); }
    }
  }
}
function run(map, difficulty, seed) {
  storage.clear();
  Math.random = seeded(seed);
  const game = new Game(canvas, { autoBind: false });
  game.startMap(map);
  game.setDifficulty(String(difficulty));
  const cells = cellsFor(game);
  let frames = 0;
  while (!game.gameOver && game.wave < 70 && frames < 900000) {
    if (game.phase === 'prep') { bot(game, cells); game.startWave(); }
    game.step();
    frames++;
  }
  const specs = {};
  for (const t of game.towers.values()) if (t.spec) specs[t.spec] = (specs[t.spec] || 0) + 1;
  console.log(`${game.map.name} · ${difficulty}档 → ${game.gameOver ? '失守' : '结束'} ${game.wave}波 | 塔 ${game.towers.size} | 积分 ${Math.round(game.score)} | 专精 ${JSON.stringify(specs)}`);
  return game.wave;
}

console.log('== V7 固定种子平衡模拟 ==');
const results = [run(0, 1, 7001), run(0, 3, 7002), run(3, 1, 7003), run(3, 3, 7004)];
if (results.some(n => !Number.isFinite(n) || n < 5)) process.exit(1);
