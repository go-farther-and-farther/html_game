const fs = require('fs');
const html = fs.readFileSync('D:/Software files/html game/pelican-free-ride.html', 'utf8');
const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!m) { console.error('no module script found'); process.exit(1); }
fs.writeFileSync('D:/Software files/html game/syntax-check.mjs', m[1]);
console.log('extracted', m[1].length, 'chars');
// 检查 script 标签数量
const count = (html.match(/<script/g) || []).length;
console.log('script tags:', count);
