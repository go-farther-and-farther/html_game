// 从仓库根目录生成 Capacitor 打包目录 www/
// www 是构建产物（已 gitignore），请勿手工编辑——直接修改根目录源文件后重新运行本脚本
// 注：不用 fs.cpSync —— 在部分 Windows 环境递归复制目录会触发安全软件导致进程被静默终止
import { rmSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// 打包进 APK 的内容：首页、历史页、下载页、共享样式/脚本、全部游戏目录
// 新增游戏时在下面列表补一行即可：文件夹名直接写文件夹名，根目录的单文件游戏要单独写一行
const items = [
  'index.html',
  'history.html',
  'download.html',
  'favicon.svg',
  'css',
  'js',
  '人生清单',
  '2048',
  '俄罗斯方块',
  '贪吃蛇',
  '修仙天赋模拟器',
  '塔防游戏',
  '我的世界',
  '泰坦尼克号',
  '雨夜便利店',
  '雨夜加油站',
  '鹈鹕骑车3D',
];

// 仅网页内容：动画合集与鹈鹕骑车的 3 个演示版本不打进 APK（free-ride 游戏保留）
const skip = new Set([
  'animations.html',
  '鹈鹕骑车3D/versions.html',
  '鹈鹕骑车3D/index.html',
  '鹈鹕骑车3D/pelican-cycling-svg-v1.html',
  '鹈鹕骑车3D/pelican-bicycle-svg.html',
  '鹈鹕骑车3D/pelican-bicycle.svg',
  '鹈鹕骑车3D/pelican_bicycle.svg',
  '鹈鹕骑车3D/pelican-bike.svg',
]);

// 目录名命中即整目录跳过：测试脚本/设计文档/旧备份不需要进安装包
const excludeDirs = new Set(['tests', 'docs', 'backup', 'node_modules', '.git', '.idea']);

function copyTree(src, dst, relPath) {
  if (skip.has(relPath)) return;
  const st = statSync(src);
  if (st.isDirectory()) {
    const base = relPath.split('/').pop();
    if (excludeDirs.has(base)) return;
    mkdirSync(dst, { recursive: true });
    for (const entry of readdirSync(src)) {
      copyTree(join(src, entry), join(dst, entry), relPath + '/' + entry);
    }
  } else {
    mkdirSync(join(dst, '..'), { recursive: true });
    writeFileSync(dst, readFileSync(src));
  }
}

// 不删除 www 目录本身（可能被进程占用导致 EBUSY），只清空内容
mkdirSync('www', { recursive: true });
for (const entry of readdirSync('www')) {
  rmSync(join('www', entry), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

for (const item of items) {
  copyTree(item, join('www', item), item);
}

// 校验：首页 GAMES 清单里的每个 href 都必须真的进了 www，否则 APK 会静默缺页
const indexHtml = readFileSync('index.html', 'utf8');
const hrefs = [...indexHtml.matchAll(/href:\s*'([^']+)'/g)].map(m => m[1]);
const missing = [...new Set(hrefs)].filter(href => !existsSync(join('www', href)));
if (missing.length) {
  console.error('打包校验失败，以下首页链接在 www 里不存在：');
  for (const href of missing) console.error('  - ' + href);
  process.exit(1);
}

for (const required of ['index.html', 'history.html', 'download.html', 'css/site.css', 'js/history.js']) {
  if (!existsSync(join('www', required))) {
    console.error('打包校验失败，缺少必需文件：' + required);
    process.exit(1);
  }
}

// 版本号一致性：package.json / js/version.js / android build.gradle 必须一致
const pkgVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
const jsVersion = (readFileSync('js/version.js', 'utf8').match(/APP_VERSION\s*=\s*'([^']+)'/) || [])[1];
const gradleVersion = (readFileSync('android/app/build.gradle', 'utf8').match(/versionName\s+"([^"]+)"/) || [])[1];
if (pkgVersion !== jsVersion || pkgVersion !== gradleVersion) {
  console.error('版本号不一致，请先统一：');
  console.error(`  package.json        = ${pkgVersion}`);
  console.error(`  js/version.js       = ${jsVersion}`);
  console.error(`  build.gradle        = ${gradleVersion}`);
  process.exit(1);
}

console.log('www 已生成，共复制 ' + items.length + ' 个条目（已排除 ' + skip.size + ' 个仅网页文件），首页 ' + new Set(hrefs).size + ' 个链接全部存在，版本 ' + pkgVersion);
