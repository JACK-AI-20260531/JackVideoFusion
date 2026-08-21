/**
 * postbuild-fix-asar.cjs
 * electron-builder afterPack hook: 修复 asar 里依赖嵌套问题
 * 某些包被嵌套到子包 node_modules/ 下,导致其他包 require 找不到
 * 本脚本提取 asar → 把缺失包复制到顶层 → 重新打包
 *
 * 也可独立运行: node scripts/postbuild-fix-asar.cjs
 */
const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');

// afterPack hook 接收 context,独立运行时从默认路径读
function getAsarPath(context) {
  if (context && context.appOutDir) {
    return path.join(context.appOutDir, 'resources', 'app.asar');
  }
  return path.join(__dirname, '..', 'release', 'win-unpacked', 'resources', 'app.asar');
}

// 需要从子包 node_modules 提升到顶层的包
const ELEVATE = [
  { packageName: 'call-bind-apply-helpers', nestedUnder: 'call-bind' },
];

function fixAsar(context) {
  const ASAR_PATH = getAsarPath(context);
  const TEMP_DIR = path.join(path.dirname(ASAR_PATH), '_asar_temp');

  if (!fs.existsSync(ASAR_PATH)) {
    console.log('[postbuild] asar 不存在,跳过:', ASAR_PATH);
    return;
  }

  console.log('[postbuild] 开始修复 asar 依赖嵌套...');

  // 1. 提取 asar
  if (fs.existsSync(TEMP_DIR)) {
    fs.rmSync(TEMP_DIR, { recursive: true });
  }
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  asar.extractAll(ASAR_PATH, TEMP_DIR);

  // 2. 复制嵌套包到顶层
  let fixed = 0;
  for (const { packageName, nestedUnder } of ELEVATE) {
    const nestedPath = path.join(TEMP_DIR, 'node_modules', nestedUnder, 'node_modules', packageName);
    const topLevelPath = path.join(TEMP_DIR, 'node_modules', packageName);

    if (fs.existsSync(nestedPath) && !fs.existsSync(topLevelPath)) {
      fs.cpSync(nestedPath, topLevelPath, { recursive: true });
      console.log(`[postbuild] 已提升 ${packageName} ← node_modules/${nestedUnder}/node_modules/`);
      fixed++;
    } else if (fs.existsSync(topLevelPath)) {
      console.log(`[postbuild] ${packageName} 已在顶层,跳过`);
    } else {
      console.log(`[postbuild] 警告: ${nestedPath} 不存在,跳过`);
    }
  }

  if (fixed === 0) {
    console.log('[postbuild] 无需修复');
    fs.rmSync(TEMP_DIR, { recursive: true });
    return;
  }

  // 3. 同步重新打包 asar (用 execSync 调 npx asar)
  fs.rmSync(ASAR_PATH);
  const { execSync } = require('child_process');
  execSync(`npx asar pack "${TEMP_DIR}" "${ASAR_PATH}"`, { stdio: 'inherit' });
  const sizeMB = (fs.statSync(ASAR_PATH).size / 1048576).toFixed(1);
  console.log(`[postbuild] asar 已重新打包 (${sizeMB} MB)`);
  fs.rmSync(TEMP_DIR, { recursive: true });
  console.log('[postbuild] 修复完成');
}

// 支持两种调用方式:afterPack hook(context) 或独立运行
if (require.main === module) {
  fixAsar(null);
} else {
  module.exports = function (context) {
    fixAsar(context);
  };
}
