'use strict';
/* 《测灵台·修仙天赋模拟器 v2》验收断言测试(设计文档第九节)
 * 运行:node test-v2.js
 * 从单文件 HTML 中提取 <script id="app"> 的核心逻辑,以最小方式直接执行(不加载 DOM)。
 */
const fs = require('fs'), path = require('path');
const file = path.join(__dirname, '修仙天赋模拟器-v2.html');
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/<script id="app">([\s\S]*?)<\/script>/);
if (!m){ console.error('未找到 <script id="app">'); process.exit(1); }
const CORE = new Function(m[1] + '\n;return CORE;')();

let pass = 0, fail = 0;
function ok(cond, msg){
  if (cond){ pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.error('  ✗ ' + msg); }
}
const P = o => Object.assign({ alpha:1.0, waste:0.0, heaven:6.0, affinity:[1,1,1,1,1] }, o || {});

/* ---------- 单元:品级线插值与边界语义 ---------- */
console.log('\n[1] 品级线插值与边界');
const L0 = CORE.computeLines(0, 6);
ok(L0.low === 1.5 && L0.mid === 3 && L0.high === 4.5, '默认插值线 = 1.5 / 3.0 / 4.5');
ok(CORE.gradeOf(0, L0)   === '无', '分数 0(≤废线)= 无灵根,不是废灵根');
ok(CORE.gradeOf(0.1, L0) === '废', '0.1 > 0 为废灵根(废是「大于」)');
ok(CORE.gradeOf(1.5, L0) === '下', '1.5 ≥ 下品线(含边界)');
ok(CORE.gradeOf(3.0, L0) === '中', '3.0 ≥ 中品线(含边界)');
ok(CORE.gradeOf(4.5, L0) === '上', '4.5 ≥ 上品线(含边界)');
ok(CORE.gradeOf(6.0, L0) === '天', '6.0 ≥ 天灵根线(含边界)');

/* ---------- 单元:灵子分配守恒 ---------- */
console.log('\n[2] 灵子分配守恒');
let conserve = true, checked = 0;
for (let t = 0; t < 500; t++){
  const alive = [0,0,0,0,0].map(() => Math.random() < 0.9 ? 1 : 0);
  if (alive.every(v => !v)) continue;
  const grains = 1 + Math.floor(Math.random() * 100);
  const cnt = CORE.allocateGrains(grains, alive, 0.1 + Math.random()*1.9, [1,2,0.5,3,1]);
  if (cnt.reduce((a,b) => a+b, 0) !== grains){ conserve = false; break; }
  checked++;
}
ok(conserve && checked > 400, `总灵子守恒(抽样 ${checked} 次,含各系分数非负整数粒)`);

/* ---------- 大样本:30 万 ---------- */
console.log('\n[3] 大样本 30 万:范围 / 均值 / 分桶 / 口径互斥 / 命名一致性');
const N = 300000, T = CORE.emptyTally();
let rangeOK = true, zeroUnique = true, mortalEquiv = true, titleConsistent = true;
const TITLE_RANK = { '凡 人':0, '下品灵根':2, '中品灵根':3, '上品灵根':4 };
function titleRank(t){
  if (t === '绝灵体') return -1;
  if (t.startsWith('多系天灵根') || t.startsWith('天灵根')) return 5;
  return TITLE_RANK[t] !== undefined ? TITLE_RANK[t] : -2;
}
for (let i = 0; i < N; i++){
  const p = CORE.rollPerson(P(), true);
  CORE.tallyPerson(T, p);
  if (p.dead){
    if (p.talent !== 0) zeroUnique = false;          // 绝灵体总天赋 = 0
  } else {
    if (!(p.talent >= 0.1 && p.talent <= 10)) rangeOK = false;   // 100% ∈ [0.1,10]
    let hasReal = false, peak = 0;
    for (const g of p.grades){ const r = CORE.GRADE_RANK[g]; if (r >= 2) hasReal = true; if (r > peak) peak = r; }
    if (!hasReal && p.title !== '凡 人') mortalEquiv = false;    // 无下品 ⇔ 凡人
    if (hasReal && titleRank(p.title) !== peak) titleConsistent = false;
  }
}
ok(rangeOK, '非绝灵体总天赋 100% ∈ [0.1, 10]');
ok(zeroUnique, '总天赋 0 仅出现在绝灵体身上');
const mean = T.sum / T.n;
ok(Math.abs(mean - 4) < 0.05, `总天赋均值 = ${mean.toFixed(4)}(与 4 偏差 < 0.05)`);
const theory = [5.2, 12.9, 16.8, 17.7, 16.3, 13.3, 9.6, 5.7, 2.4, 0.4];
let histOK = true; const got = [];
for (let k = 0; k < 10; k++){
  const pct = T.histogram[k] / T.n * 100;
  got.push(pct.toFixed(2));
  if (Math.abs(pct - theory[k]) >= 1) histOK = false;
}
ok(histOK, `整数分桶与理论值 ±1% 内\n      理论 [${theory.join(',')}]\n      实测 [${got.join(',')}]`);
ok(T.dead + T.mortal + T.gifted === T.n,
  `绝灵体(${T.dead}) + 凡人(${T.mortal}) + 身负灵根者(${T.gifted}) = 总数 ${T.n}(互斥且加总)`);
ok(mortalEquiv, '「无下品灵根且非绝灵体 ⇔ 总评 = 凡 人」');
ok(titleConsistent, '总评品级标题与最高单系分数的品级一致');

/* ---------- 排行榜口径 ---------- */
console.log('\n[4] 排行榜(10 万流,独立口径对账)');
const board = [], L = CORE.computeLines(0, 6);
let maxQ = 0, qn = 0, anyMidUp = false;
for (let i = 0; i < 100000; i++){
  const p = CORE.rollPerson(P(), true);
  let q = -1;
  for (let j = 0; j < 5; j++){
    if (CORE.GRADE_RANK[p.grades[j]] >= 2){ if (q >= 0){ q = -2; break; } q = j; }
  }
  if (q >= 0){ qn++; const s = p.scores[q]; if (s > maxQ) maxQ = s; if (s >= L.mid) anyMidUp = true; }
  CORE.leaderboardPush(board, p);
}
ok(board.length > 0 && board.length <= 10, `榜单条数 = ${board.length}(≤ 10)`);
let sorted = true, aboveLine = true, fieldsOK = true;
for (let i = 0; i < board.length; i++){
  if (i && board[i-1].score < board[i].score) sorted = false;
  if (board[i].score < L.low) aboveLine = false;
  if (!(board[i].id > 0 && board[i].talent >= 0.1)) fieldsOK = false;
}
ok(sorted, '榜单按单系分数降序');
ok(aboveLine, '每条分数 ≥ 下品线');
ok(fieldsOK, '每条含编号与总天赋且合法');
ok(qn > 0 && board[0].score === maxQ,
  `榜首 = 全场「恰一系达标者」单系最高分(达标 ${qn} 人,榜首 ${board[0].score} = 独立对账 ${maxQ})`);
ok(anyMidUp && board.some(e => e.score >= L.mid), '榜单含中品及以上(未被 2.9 封顶,不限品级口径未回退)');

/* ---------- 天灵根评语路径(历史崩溃点) ---------- */
console.log('\n[5] 天灵根评语路径');
try {
  let tian = 0, multi = 0;
  for (let i = 0; i < 30000; i++){
    const p = CORE.rollPerson(P({ alpha:0.1, waste:0, heaven:1.0 }), false);
    if (typeof p.title !== 'string' || !p.title) throw new Error('出现空标题');
    if (p.title.startsWith('天灵根 · ')) tian++;
    if (p.title.startsWith('多系天灵根 · ')) multi++;
  }
  ok(tian > 0 && multi > 0, `天灵根(${tian})与多系天灵根(${multi})命名路径均无异常`);
} catch (e) {
  ok(false, '天灵根评语路径抛错:' + e.message);
}

/* ---------- 极端参数冒烟 ---------- */
console.log('\n[6] 极端参数冒烟');
try {
  const T2 = CORE.emptyTally();
  for (let i = 0; i < 20000; i++){
    const p = CORE.rollPerson(P({ alpha:2, waste:5, heaven:9, affinity:[5,0.5,3,0.5,0.5] }), false);
    if (!p.dead && p.talent === 0) throw new Error('非绝灵体出现 0');
    CORE.tallyPerson(T2, p);
  }
  ok(T2.dead + T2.mortal + T2.gifted === T2.n, '极端参数(废线 5 / 天线 9 / 不均匀吸附)下口径依然闭合');
} catch (e) {
  ok(false, '极端参数冒烟失败:' + e.message);
}

console.log(`\n===== 结果:${pass} 通过,${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
