const fs = require('fs');
// 源文件在 2026-08 的目录整理中移入了 鹈鹕骑车3D/，这里跟着改路径
const html = fs.readFileSync('D:/Software files/html game/鹈鹕骑车3D/pelican-free-ride.html', 'utf8');
const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!m) { console.error('no module script found'); process.exit(1); }
fs.writeFileSync('D:/Software files/html game/工具脚本/syntax-check.mjs', m[1]);
console.log('extracted', m[1].length, 'chars');
// 检查 script 标签数量
const count = (html.match(/<script/g) || []).length;
console.log('script tags:', count);
