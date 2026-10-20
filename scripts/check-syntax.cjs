// 全站 HTML 内联脚本语法检查：遍历所有页面，用 Node 解析每个 <script>
// 用法：node scripts/check-syntax.cjs   （npm run check）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'www', 'android', '.idea', '视频', '文档', 'img']);
const SKIP_FILES = new Set(['404.html']);
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

function collect(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collect(full, out);
    } else if (entry.name.toLowerCase().endsWith('.html') && !SKIP_FILES.has(entry.name)) {
      out.push(full);
    }
  }
}

const files = [];
collect(ROOT, files);
files.sort();

let total = 0;
let failed = 0;

for (const file of files) {
  const html = fs.readFileSync(file, 'utf8');
  let match;
  let index = 0;
  while ((match = SCRIPT_RE.exec(html))) {
    const attrs = match[1] || '';
    const code = match[2] || '';
    if (!code.trim()) continue;
    if (/\bsrc\s*=/.test(attrs)) continue; // 外链脚本单独处理，node --check 无法解析路径
    const type = (attrs.match(/\btype\s*=\s*["']([^"']+)["']/) || [])[1] || 'text/javascript';
    if (/json|importmap|text\/template|text\/plain/i.test(type)) continue;

    const isModule = /module/i.test(type);
    index++;
    total++;
    const tmp = path.join(os.tmpdir(), `htmlcheck-${process.pid}-${total}.${isModule ? 'mjs' : 'cjs'}`);
    fs.writeFileSync(tmp, code, 'utf8');
    const res = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
    fs.unlinkSync(tmp);

    if (res.status !== 0) {
      failed++;
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const detail = (res.stderr || '').trim().split('\n').slice(0, 8).join('\n');
      console.error(`\n✗ ${rel}（第 ${index} 个内联脚本）\n${detail}`);
    }
  }
}

console.log(`\n检查完成：${files.length} 个 HTML，${total} 段内联脚本，失败 ${failed} 段`);
if (failed > 0) process.exit(1);
