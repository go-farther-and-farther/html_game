// 从仓库根目录生成 Capacitor 打包目录 www/
// www 是构建产物（已 gitignore），请勿手工编辑——直接修改根目录源文件后重新运行本脚本
// 注：不用 fs.cpSync —— 在部分 Windows 环境递归复制目录会触发安全软件导致进程被静默终止
import { rmSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// 打包进 APK 的内容：首页、历史页、共享脚本、全部游戏目录
// 新增游戏文件夹时在下面列表补一行即可
const items = [
  'index.html',
  'history.html',
  'js',
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

function copyTree(src, dst) {
  const st = statSync(src);
  if (st.isDirectory()) {
    mkdirSync(dst, { recursive: true });
    for (const entry of readdirSync(src)) {
      copyTree(join(src, entry), join(dst, entry));
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
  copyTree(item, join('www', item));
}

console.log('www 已生成，共复制 ' + items.length + ' 个条目');
