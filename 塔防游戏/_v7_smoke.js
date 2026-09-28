/* 元素哨站 V7 行为测试：直接加载真实 HTML 中的游戏脚本。 */
const fs = require('fs');

let pass = 0;
let fail = 0;
function ok(value, name) {
  if (value) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}
function eq(actual, expected, name) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${name}（实际 ${JSON.stringify(actual)}）`);
}

console.log('== V7 产物 ==');
const path = 'elemental_outpostV7.html';
ok(fs.existsSync(path), 'V7 单文件存在');
if (!fs.existsSync(path)) {
  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(1);
}

const ctxTarget = {};
const gradient = { addColorStop() {} };
const ctx = new Proxy(ctxTarget, {
  get(target, key) {
    if (key === 'measureText') return text => ({ width: String(text).length * 7 });
    if (key === 'createRadialGradient' || key === 'createLinearGradient') return () => gradient;
    if (key in target) return target[key];
    return () => {};
  },
  set(target, key, value) { target[key] = value; return true; }
});
function canvas() {
  return {
    width: 960, height: 640, style: {}, getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 640 }),
    addEventListener() {}, setPointerCapture() {}
  };
}
function element(id = '') {
  return {
    id, style: {}, dataset: {}, innerHTML: '', textContent: '', disabled: false,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    scrollIntoView() {}, appendChild() {}
  };
}
const elements = new Map();
const gameCanvas = canvas();
global.window = global;
global.performance = { now: () => 0 };
global.requestAnimationFrame = () => {};
global.addEventListener = () => {};
global.AudioContext = undefined;
global.document = {
  body: element('body'),
  getElementById(id) {
    if (id === 'game') return gameCanvas;
    if (id === 'stage') return { clientWidth: 960, clientHeight: 640 };
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  },
  querySelectorAll() { return []; },
  addEventListener(event, handler) { if (event === 'DOMContentLoaded') global.__v7boot = handler; }
};
const storage = new Map();
global.localStorage = {
  getItem: key => storage.has(key) ? storage.get(key) : null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: key => storage.delete(key)
};

const html = fs.readFileSync(path, 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/);
ok(/Elemental Outpost V7/.test(html), '标题标记为 V7');
ok(/id="diffs"/.test(html), '提供开局难度选择器');
ok(/inspectSig/.test(script ? script[1] : ''), '选中面板使用状态签名避免周期重建');
ok(!!script, '包含内联游戏脚本本');
if (!script) process.exit(1);
eval(script[1]);

const api = global.ElementalOutpostV7;
console.log('== 规则 ==');
ok(!!api, '公开稳定的规则 API');
ok(typeof api.Rules.canvasLayout === 'function', '提供高 DPI 画布布局规则');
const layout4k = typeof api.Rules.canvasLayout === 'function' ? api.Rules.canvasLayout(3514, 2160, 1) : null;
ok(layout4k && layout4k.displayWidth > 3000 && layout4k.backingWidth >= layout4k.displayWidth, '4K 画布使用接近显示尺寸的后备像素');
ok(/@media\s*\(min-width:2400px\)/.test(html), '超宽屏提供放大的侧栏与控件');
ok(typeof api.Game.prototype.drawMapPreview === 'function', '选关卡片提供真实地图缩略图绘制器');
const selectPreviewGame = new api.Game(gameCanvas, { autoBind: false });
let previewDraws = 0;
selectPreviewGame.drawMapPreview = () => { previewDraws++; };
selectPreviewGame.renderSelect(ctx);
eq(previewDraws, 4, '选关界面为四张关卡卡片绘制缩略图');
eq([1, 10, 11, 60, 61].map(api.Rules.hpScale), [0.55, 1, 1.1, 6, 6.05], '生命曲线边界');
const preview = api.Rules.previewWave(25, api.MAPS[0], '1', () => 0.99);
ok(preview.list.includes('tyrant'), '25 波预览包含暴君');
eq(preview.counts.tyrant, 1, '预览统计与队列一致');
ok(preview.reward > 0 && preview.threats.length > 0, '预览包含奖励和危险标签');

console.log('== 专精配置 ==');
eq(Object.keys(api.TOWERS).length, 13, '保留 13 种塔');
for (const [key, tower] of Object.entries(api.TOWERS)) {
  ok(tower.specs && Object.keys(tower.specs).length === 2, `${key} 有两个专精`);
}
const tower = new api.Tower('arrow', 1, 1);
ok(!tower.chooseSpec('rapid'), '3 级前不能选择专精');
tower.level = 3;
ok(!tower.canUpgrade(), '3 级未选专精时禁止升级');
ok(tower.chooseSpec('rapid'), '3 级可选择专精');
ok(!tower.chooseSpec('pierce') && tower.spec === 'rapid', '专精选择不可反复切换');
ok(tower.canUpgrade(), '选择专精后可继续升级');

console.log('== 游戏状态 ==');
const game = new api.Game(gameCanvas, { autoBind: false });
game.startMap(0, { fresh: true });
ok(game.setDifficulty('4') && game.difficulty === '4', '第一波前可调整难度');
ok(Array.isArray(game.nextWave) && game.nextWave.length > 0, '准备阶段预生成真实下一波队列');
const plannedWave = [...game.nextWave];
game.score = 99999;
ok(!game.build(-1, 0) && !game.build(0, -1) && !game.build(20, 0) && !game.build(0, 12), '拒绝战场外建造');
game.startWave(1);
eq(game.queue, plannedWave, '开波队列与此前预览完全一致');
game.spawnNow('regen');
const enemy = game.enemies[0];
enemy.distance = 123;
enemy.hp *= 0.5;
enemy.dotTime = 77;
game.setPaused(true);
const before = enemy.distance;
game.step();
ok(enemy.distance === before, '暂停冻结模拟');
ok(api.Store.snapshot().paused === true, '暂停状态立即自动保存');
const snap = game.toSnapshot();
const restored = new api.Game(gameCanvas, { autoBind: false });
ok(restored.fromSnapshot(snap), '可恢复完整 V7 快照');
eq(restored.enemies.length, 1, '恢复场上敌人');
ok(restored.enemies[0].distance === 123 && restored.enemies[0].dotTime === 77, '恢复敌人位置与状态效果');
ok(restored.paused, '恢复暂停状态');
game.wave = 1;
ok(!game.setDifficulty('3'), '第一波后锁定难度');
restored.setPaused(false);
for (let i = 0; i < 121; i++) restored.step();
const auto = api.Store.snapshot();
ok(auto.enemies && auto.enemies[0] && auto.enemies[0].distance > 123, '交战中周期保存敌人实时位置');
ok(!restored.fromSnapshot({ version: 7, map: 99, difficulty: '1' }), '拒绝非法快照');

console.log('== 迁移 ==');
storage.clear();
storage.set('elementalOutpost.v6.settings', JSON.stringify({ theme: 'light', speed: 3, difficulty: '2' }));
storage.set('elementalOutpost.v6.best', JSON.stringify({ 0: 42 }));
storage.set('elementalOutpost.v6.legacy', JSON.stringify({ career: 12345, migrated: true }));
storage.set('elementalOutpost.v6', JSON.stringify({ wave: 99 }));
api.Store.migrateV6();
eq(JSON.parse(storage.get('elementalOutpost.v7.best'))[0], 42, '迁移最高波次');
eq(JSON.parse(storage.get('elementalOutpost.v7.legacy')).career, 12345, '迁移生涯积分');
ok(!storage.has('elementalOutpost.v7'), '不迁移 V6 半局存档');

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
