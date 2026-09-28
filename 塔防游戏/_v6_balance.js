/* V6 数值平衡模拟：无头跑完整对局，bot 按价格阶梯买塔/升级，看能守到第几波 */
const fs = require('fs');

/* ---- 与 _v6_smoke 相同的 DOM stubs ---- */
const ctxStubTarget = {};
const gradientStub = { addColorStop() {} };
const ctxStub = new Proxy(ctxStubTarget, {
  get(t, k) {
    if (k === 'measureText') return () => ({ width: 10 });
    if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => gradientStub;
    if (k in t) return t[k];
    return () => {};
  },
  set(t, k, v) { t[k] = v; return true; }
});
function makeCanvasStub() {
  return { getContext: () => ctxStub, width: 900, height: 600, style: {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 600 }),
    addEventListener() {}, cursor: '' };
}
function makeElStub() {
  return { querySelector: () => null, querySelectorAll: () => [],
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    addEventListener() {}, style: {}, dataset: {},
    innerHTML: '', textContent: '', disabled: false, onclick: null };
}
const els = {};
const domCanvas = makeCanvasStub();
global.document = {
  getElementById(id) {
    if (id === 'game') return domCanvas;
    if (id === 'stage') return { clientWidth: 900, clientHeight: 600 };
    if (/^card-/.test(id)) {
      if (!els[id]) els[id] = Object.assign(makeElStub(), { querySelector: () => makeCanvasStub() });
      return els[id];
    }
    if (!els[id]) els[id] = makeElStub();
    return els[id];
  },
  addEventListener(ev, fn) { if (ev === 'DOMContentLoaded') global.__boot = fn; },
  body: { classList: { add() {}, remove() {}, toggle: () => false, contains: () => false } }
};
global.window = global;
global.addEventListener = () => {};
const store = new Map();
global.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k)
};
global.requestAnimationFrame = () => {};

const html = fs.readFileSync('elemental_outpostV6.html', 'utf-8');
eval(html.match(/<script>([\s\S]*)<\/script>/)[1]);
global.__boot();

/* ---- 覆盖率排序的可建格子（每格统计 100px 内路径格数）---- */
const CELL = 45, GRID_Y0 = 60;
function cellCenter(c, r) { return { x: c * CELL + 22.5, y: GRID_Y0 + r * CELL + 22.5 }; }
function bestCells(mapId) {
  game.map = { path: null }; // no-op guard
  const m = null;
  // 直接从 window.game 取 MAPS 不可达，改为读存档前先 startMap 再算
  return null;
}
function computeCells() {
  const cells = [];
  const pathCells = game.map.path.cells;
  for (let r = 0; r < 12; r++) for (let c = 0; c < 20; c++) {
    const k = c + ',' + r;
    if (pathCells.has(k)) continue;
    const p = cellCenter(c, r);
    let cov = 0;
    for (let r2 = 0; r2 < 12; r2++) for (let c2 = 0; c2 < 20; c2++) {
      if (!pathCells.has(c2 + ',' + r2)) continue;
      const q = cellCenter(c2, r2);
      if (Math.hypot(p.x - q.x, p.y - q.y) <= 100) cov++;
    }
    cells.push({ c, r, cov });
  }
  cells.sort((a, b) => b.cov - a.cov);
  return cells;
}

/* ---- bot：价格阶梯混合出装（箭塔≤8座）+ 升级最便宜的 ---- */
let buildCells = null;
const COST = { arrow: 60, poison: 120, ice: 180, cannon: 250, boom: 350, laser: 500,
  rail: 700, prism: 900, glaive: 1200, magnet: 1600, storm: 2200, hole: 3000, obelisk: 6000 };
const LADDER = ['arrow', 'poison', 'ice', 'cannon', 'boom', 'laser', 'rail', 'prism',
  'glaive', 'magnet', 'storm', 'hole', 'obelisk'];
const ARROW_CAP = 8;
function botLadder() {
  /* 用户策略：先按价格阶梯每塔买一座（便宜→贵），集齐后从便宜到贵逐个升级，
     全部满级后剩余名额再按阶梯补第二座。攒钱期间用箭塔垫底。 */
  let acted = true;
  while (acted) {
    acted = false;
    const owned = [...game.towers.values()];
    const ownedTypes = new Set(owned.map(t => t.t));
    const next = LADDER.find(ty => !ownedTypes.has(ty));
    const spot = () => buildCells.find(s => !game.towers.has(s.c + ',' + s.r));
    const build = ty => {
      const s = spot(); if (!s) return false;
      const before = game.towers.size;
      game.setBT(ty); game.tryBuild(s.c, s.r);
      return game.towers.size > before;
    };
    // 阶段A：集齐 13 种——买新塔需要 1.5 倍余量，其余钱随时升级（真人节奏）
    if (next) {
      if (game.score >= COST[next] * 1.5 && game.towers.size < game.maxTowers && build(next)) { acted = true; continue; }
      const arrows = owned.filter(t => t.t === 'arrow').length;
      const poisons = owned.filter(t => t.t === 'poison').length;
      if (arrows < 6 && game.score >= COST.arrow && build('arrow')) { acted = true; continue; }
      if (poisons < 2 && game.score >= COST.poison && build('poison')) { acted = true; continue; }
      let best = null;
      for (const t of owned) {
        if (!t.canUp()) continue;
        const c = t.upCost();
        if (game.score >= c && (!best || t.lv < best.t.lv || (t.lv === best.t.lv && c < best.c))) best = { t, c };
      }
      if (best) { game.score -= best.c; best.t.lv++; best.t.setLevel(best.t.lv); best.t.inv += best.c; acted = true; continue; }
      continue;
    }
    // 阶段B：从便宜到贵逐个升级（优先等级最低的）
    let best = null;
    for (const t of owned) {
      if (!t.canUp()) continue;
      const c = t.upCost();
      if (game.score >= c && (!best || t.lv < best.t.lv || (t.lv === best.t.lv && c < best.c))) best = { t, c };
    }
    if (best) { game.score -= best.c; best.t.lv++; best.t.setLevel(best.t.lv); best.t.inv += best.c; acted = true; continue; }
    // 阶段C：全满级后，剩余名额按阶梯补第二座
    if (game.towers.size < game.maxTowers) {
      for (const ty of LADDER) {
        if (game.score >= COST[ty] && build(ty)) { acted = true; break; }
      }
    }
  }
}
function botSpam() {
  /* 基线：箭塔≤8 + 毒雾海 */
  let acted = true;
  while (acted) {
    acted = false;
    if (game.towers.size < game.maxTowers) {
      const arrows = [...game.towers.values()].filter(t => t.t === 'arrow').length;
      const poisons = [...game.towers.values()].filter(t => t.t === 'poison').length;
      if (arrows < ARROW_CAP && game.score >= COST.arrow) { if (build2('arrow')) { acted = true; continue; } }
      if (poisons < 14 && game.score >= COST.poison) { if (build2('poison')) { acted = true; continue; } }
    }
    let best = null;
    for (const t of game.towers.values()) {
      if (!t.canUp()) continue;
      const c = t.upCost();
      if (game.score >= c && (!best || c < best.c)) best = { t, c };
    }
    if (best) { game.score -= best.c; best.t.lv++; best.t.setLevel(best.t.lv); best.t.inv += best.c; acted = true; }
  }
}
function build2(ty) {
  const s = buildCells.find(s => !game.towers.has(s.c + ',' + s.r));
  if (!s) return false;
  const before = game.towers.size;
  game.setBT(ty); game.tryBuild(s.c, s.r);
  return game.towers.size > before;
}
function runSim(mapId, dk, label, botFn) {
  store.clear();
  game.career = 0;
  game.goSel();
  game.startMap(mapId);
  game.dk = dk;
  buildCells = computeCells();
  let frames = 0;
  const MAX_FRAMES = 60 * 60 * 30; // 30 分钟游戏时间上限
  while (!game.go && game.w < 100 && frames < MAX_FRAMES) {
    if (game.phase === 'prep') { botFn(); game.skip(); }
    game.update();
    frames++;
  }
  const towers = [...game.towers.values()];
  const byType = {};
  towers.forEach(t => byType[t.t] = (byType[t.t] || 0) + 1);
  console.log(`[${label}] map=${game.map.name} 难度=${dk} → ${game.go ? '游戏结束' : '守住'} 第 ${game.w} 波 | 塔数 ${game.towers.size} | 积分 ${game.score} | 生涯 ${game.career}`);
  console.log(`   塔种: ${JSON.stringify(byType)} | 各塔等级: ${towers.map(t => t.t.slice(0, 2) + t.lv).sort().join(' ')}`);
  return { wave: game.w, over: game.go };
}

console.log('== V6 数值平衡模拟（bot：按价格阶梯混合买塔+升级，无技能）==');
for (const [name, fn] of [['阶梯流', botLadder], ['低价海', botSpam]]) {
  console.log(`-- 策略：${name} --`);
  runSim(0, '1', '地图1·难度1', fn);
  runSim(0, '2', '地图1·难度2', fn);
  runSim(0, '3', '地图1·难度3', fn);
  runSim(3, '1', '地图4·难度1', fn);
  runSim(3, '3', '地图4·难度3', fn);
}
