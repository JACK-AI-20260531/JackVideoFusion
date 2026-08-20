/**
 * OCR 端到端冒烟脚本(开发辅助,Electron 主进程)
 *
 * 用法:
 *   npm run dev:electron 前的独立冒烟:
 *     node_modules/electron/dist/electron.exe scripts/ocr-smoke.cjs <videoPath> [--lang=chi_sim]
 *
 * 职责:在真实 Electron 主进程环境(含 BrowserWindow 依赖的 logger/ffmpegService)
 *      跑通「抽帧→OCR→合并→写SRT」完整链路,并创建视频号适配器做注册冒烟。
 *      通过则退出码 0,失败退出码 1。
 *
 * 说明:不属单元测试(依赖真实 ffmpeg/tesseract/Electron),仅在本地开发时人工运行。
 */
require('tsx/cjs');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app } = require('electron');

// 解析命令行参数:argv 形如 [electron, 本脚本, ...用户参数],
// 第一个非开关参数为视频路径
const args = process.argv.slice(2);
let video = '';
let lang = 'chi_sim';
for (const a of args) {
  if (a.startsWith('--lang=')) lang = a.slice('--lang='.length);
  else if (!a.startsWith('-') && !video) video = a;
}
if (!video || !fs.existsSync(video)) {
  console.error('用法: electron scripts/ocr-smoke.cjs <videoPath> [--lang=chi_sim]');
  app.exit(1);
  return;
}

const out = path.join(os.tmpdir(), `ocr-smoke-${Date.now()}.srt`);

app.whenReady().then(async () => {
  try {
    // 1) 发布平台适配器注册冒烟(含 shipinhao 视频号)
    const { adapterFactory, PLATFORM_NAMES } = require('../src/main/services/auto-publish/adapters/index.ts');
    const spzx = adapterFactory('shipinhao');
    console.log('[SMOKE-1] shipinhao adapter:', spzx.constructor.name, '| 中文名:', PLATFORM_NAMES['shipinhao']);

    // 2) OCR 完整管线
    const { extractSubtitleOcr } = require('../src/main/services/ocr/index.ts');
    console.log('[SMOKE-2] video=', video, 'lang=', lang);
    const t0 = Date.now();
    const p = await extractSubtitleOcr({
      params: { videoPath: video, outputPath: out, intervalSec: 1, lang: lang, maxFrames: 60 },
      onProgress: (pct, phase) => {
        const pf = String(Math.round(pct * 100)).padStart(3);
        process.stdout.write(`\r  [ ${pf}% ] ${phase}                    `);
      },
    });
    const srt = fs.readFileSync(p, 'utf8');
    console.log('\n[SMOKE-2] SRT written:', p, 'chars=', srt.length, 'elapsed=', ((Date.now() - t0) / 1000).toFixed(1) + 's');
    if (srt.trim().length > 0) {
      console.log('[SMOKE] PASS: OCR 生成非空 SRT(共', (srt.match(/\n\n/g) || []).length + 1, '条字幕)');
      app.exit(0);
    } else {
      console.log('[SMOKE] WARN: SRT 为空');
      app.exit(1);
    }
  } catch (e) {
    console.error('[SMOKE] FAILED:', e && e.stack ? e.stack : e);
    app.exit(1);
  }
});
