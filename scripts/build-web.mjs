// 从仓库根目录生成 Capacitor 打包目录 www/
// www 是构建产物（已 gitignore），请勿手工编辑——直接修改根目录源文件后重新运行本脚本
// 注：不用 fs.cpSync —— 在部分 Windows 环境递归复制目录会触发安全软件导致进程被静默终止
import { rmSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
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

// 仅网页内容：动画合集与鹈鹕骑车的 9 个演示版本不打进 APK（free-ride 游戏保留）
const skip = new Set([
  'animations.html',
  '鹈鹕骑车3D/versions.html',
  '鹈鹕骑车3D/index.html',
  '鹈鹕骑车3D/pelican-3d-cdn.html',
  '鹈鹕骑车3D/pelican-cycling-svg-v1.html',
  '鹈鹕骑车3D/pelican-bicycle-svg.html',
  '鹈鹕骑车3D/鹈鹕5.3flash.html',
  '鹈鹕骑车3D/pelican_bicycleqwen38fn.html',
  '鹈鹕骑车3D/pelican-bike27B.html',
  '鹈鹕骑车3D/qwen3.8_27b_nvfp4_pelican-riding-v2.html',
  '鹈鹕骑车3D/deepseek_html_醍醐骑自行车.html',
  '鹈鹕骑车3D/pelican-bicycle.svg',
  '鹈鹕骑车3D/pelican_bicycle.svg',
  '鹈鹕骑车3D/pelican-bike.svg',
]);

function copyTree(src, dst, relPath) {
  if (skip.has(relPath)) return;
  const st = statSync(src);
  if (st.isDirectory()) {
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

console.log('www 已生成，共复制 ' + items.length + ' 个条目（已排除 ' + skip.size + ' 个仅网页文件）');
