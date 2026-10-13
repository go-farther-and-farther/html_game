/* 用启发式 AI 检查"困难版"是否公平：会玩的人大概能拿多少分 */
const SIZE = 5;
function mulberry32(seed){let a=seed>>>0;return function(){a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
function makeGrid(){return Array.from({length:SIZE},()=>Array(SIZE).fill(0));}
function empties(g){const a=[];for(let r=0;r<SIZE;r++)for(let c=0;c<SIZE;c++)if(!g[r][c])a.push(r*SIZE+c);return a;}
function slide(row){let a=row.filter(v=>v),gain=0,flag=false;for(let i=0;i<a.length-1;i++){if(a[i]===a[i+1]){a[i]*=2;gain+=a[i];if(a[i]===2048)flag=true;a.splice(i+1,1);}}while(a.length<SIZE)a.push(0);return{row:a,gain,flag};}
function apply(g,d){const n=g.map(r=>r.slice());let gain=0,flag=false;
 if(d===0){for(let r=0;r<SIZE;r++){const s=slide(n[r]);n[r]=s.row;gain+=s.gain;flag=flag||s.flag;}}
 else if(d===3){for(let r=0;r<SIZE;r++){const s=slide(n[r].slice().reverse());n[r]=s.row.reverse();gain+=s.gain;flag=flag||s.flag;}}
 else if(d===1){for(let c=0;c<SIZE;c++){let col=[];for(let r=0;r<SIZE;r++)col.push(n[r][c]);const s=slide(col);for(let r=0;r<SIZE;r++)n[r][c]=s.row[r];gain+=s.gain;flag=flag||s.flag;}}
 else{for(let c=0;c<SIZE;c++){let col=[];for(let r=0;r<SIZE;r++)col.push(n[r][c]);const s=slide(col.slice().reverse());const out=s.row.reverse();for(let r=0;r<SIZE;r++)n[r][c]=out[r];gain+=s.gain;flag=flag||s.flag;}}
 let moved=false;for(let r=0;r<SIZE;r++)for(let c=0;c<SIZE;c++)if(n[r][c]!==g[r][c])moved=true;
 return{g:n,gain,moved,flag};}
function canMove(g){for(let r=0;r<SIZE;r++)for(let c=0;c<SIZE;c++){if(!g[r][c])return true;if(c<SIZE-1&&g[r][c]===g[r][c+1])return true;if(r<SIZE-1&&g[r][c]===g[r+1][c])return true;}return false;}
const LOG=v=>v?Math.log2(v):0;
function heur(g){
  let empty=0,maxV=0,sum=0;
  for(let r=0;r<SIZE;r++)for(let c=0;c<SIZE;c++){const v=g[r][c];if(!v)empty++;else{maxV=Math.max(maxV,v);sum+=v;}}
  // 蛇形顺序：把 25 格排成一条从左上角绕出去的蛇形链，鼓励沿链单调递减
  const snake=[];for(let r=0;r<SIZE;r++){const cols=r%2?[...Array(SIZE).keys()].reverse():[...Array(SIZE).keys()];for(const c of cols)snake.push(g[r][c]);}
  let mono=0;
  for(let i=0;i<SIZE;i++){const a=snake[i],b=snake[i+1];if(a&&b)mono+=(a>b?a-b:b-a);}
  let smooth=0;
  for(let r=0;r<SIZE;r++)for(let c=0;c<SIZE;c++){const v=g[r][c];if(!v)continue;
    if(c<SIZE-1&&g[r][c+1])smooth+=Math.abs(LOG(v)-LOG(g[r][c+1]));
    if(r<SIZE-1&&g[r+1][c])smooth+=Math.abs(LOG(v)-LOG(g[r+1][c]));}
  const corner=g[0][0];
  return empty*140 - mono*3.2 - smooth*9 + LOG(corner)*95 + LOG(maxV)*18 - (maxV&&corner!==maxV?60:0);
}
function expectimax(g,depth){
  if(depth===0)return heur(g);
  let best=-Infinity;
  for(let d=0;d<4;d++){
    const{g:ng,gain,moved}=apply(g,d);
    if(!moved)continue;
    let val=gain;
    if(depth>1){
      const cells=empties(ng);
      if(!cells.length){val+=heur(ng);}
      else{
        // 期望：每个空格 × {2:90%, 4:10%}，空格多时抽样以提速
        const pick=cells.length>10?cells.filter((_,i)=>i%Math.ceil(cells.length/10)===0):cells;
        let acc=0;
        for(const cell of pick){const r=(cell/SIZE)|0,c=cell%SIZE;
          for(const v of[2,4]){const p=v===2?0.9:0.1;ng[r][c]=v;acc+=p*expectimax(ng,depth-1);}
          ng[r][c]=0;}
        val+=acc/pick.length;
      }
    } else val+=heur(ng);
    if(val>best)best=val;
  }
  return best===-Infinity?-1e9:best;
}
function aiGame(seed,spawn,depth=2){
  const rng=mulberry32(seed);const g=makeGrid();let score=0,won=false,moves=0;
  const put=v=>{const e=empties(g);if(!e.length)return;const cell=e[Math.floor(rng()*e.length)];g[(cell/SIZE)|0][cell%SIZE]=v;};
  put(rng()<0.9?2:4);put(rng()<0.9?2:4);
  while(moves<200000){
    let best=-Infinity,bestD=-1;
    for(let d=0;d<4;d++){const{g:ng,gain,moved}=apply(g,d);if(!moved)continue;
      const cells=empties(ng);let val=gain;
      if(cells.length){const pick=cells.length>10?cells.filter((_,i)=>i%Math.ceil(cells.length/10)===0):cells;let acc=0;
        for(const cell of pick){const r=(cell/SIZE)|0,c=cell%SIZE;for(const v of[2,4]){const p=v===2?0.9:0.1;ng[r][c]=v;acc+=p*expectimax(ng,depth-1);}ng[r][c]=0;}
        val+=acc/pick.length;}
      else val+=heur(ng);
      if(val>best){best=val;bestD=d;}
    }
    if(bestD<0)break;
    const{g:ng,gain,moved,flag}=apply(g,bestD);if(!moved)break;
    for(let r=0;r<SIZE;r++)for(let c=0;c<SIZE;c++)g[r][c]=ng[r][c];
    score+=gain;if(flag)won=true;   // 只有真正合成出 2048 方块才算通关
    for(let k=0;k<spawn;k++)put(rng()<0.9?2:4);
    moves++;
    if(!canMove(g))break;
  }
  let mt=0;for(let r=0;r<SIZE;r++)for(let c=0;c<SIZE;c++)mt=Math.max(mt,g[r][c]);
  return{score,maxTile:mt,moves,won};
}
/* 用法: node _sim-ai.mjs [局数] [搜索深度] [每步生成数,逗号分隔] */
const N=parseInt(process.argv[2]||'40',10);
const DEPTH=parseInt(process.argv[3]||'2',10);
const SPAWNS=(process.argv[4]||'1,2').split(',').map(Number);
for(const spawn of SPAWNS){
  const label=spawn===1?'原版 每步1块':`困难版 每步${spawn}块`;
  const res=[];for(let k=0;k<N;k++)res.push(aiGame(8000+k,spawn,DEPTH));
  const s=res.map(r=>r.score).sort((a,b)=>a-b);const n=s.length,q=p=>s[Math.min(n-1,Math.floor(p*n))];
  const tiles={};res.forEach(r=>tiles[r.maxTile]=(tiles[r.maxTile]||0)+1);
  console.log(`${label} AI(depth=${DEPTH}) ${n}局: 平均 ${Math.round(s.reduce((a,b)=>a+b,0)/n)}  中位 ${q(0.5)}  最高 ${s[n-1]}  最低 ${s[0]}  达2048 ${(res.filter(r=>r.won).length/n*100).toFixed(0)}%  平均步数 ${Math.round(res.reduce((a,r)=>a+r.moves,0)/n)}  最大方块分布 ${Object.entries(tiles).sort((a,b)=>b[0]-a[0]).map(([v,c])=>`${v}:${c}`).join(' ')}`);
}
