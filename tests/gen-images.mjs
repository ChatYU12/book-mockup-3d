#!/usr/bin/env node
/**
 * tests/gen-images.mjs — 生成验收用测试图（fixtures）。
 *
 * 做法：headless Chrome 里用 <canvas> 2D 绘制，toDataURL('image/png') 回传，
 * Node 侧落盘到 tests/fixtures/。不用任何第三方图像库。
 *
 * 产出：
 *   cover-1850x2600.png   底色 + 明显边框 + 100px 网格 + 右下角文字标记 + 右边缘竖彩条
 *   spine-100x2600.png    与封面右边缘同相位/同宽度的竖彩条画在左边缘，其余纯色
 *   spine-bad-100x1000.png  1:10 比例，用于触发比例告警
 *   bg-custom-1600x1200.png 自制自定义背景
 *
 * 关于彩条带宽的说明（与需求原文的细微取舍）：
 *   原文「右边缘 40px 内画 12 道等宽竖直彩色条」。40/12 不是整数，做成
 *   3.333px 会在每条边界上产生半透明过渡，反而让"接缝是否错位"的判据变糊。
 *   所以这里取 12 × 3px = 36px 的彩条带，整条带位于右边缘 40px 以内
 *   （紧贴右边缘，右边 36px），等宽、边界清晰。左侧同理。
 *
 * 相位设计：解卷后（封面自左向右 → 折角 → 书脊向外）应是一条连续的三色周期带。
 *   封面最后一列是 index 11（蓝），书脊第一列是 index 0（红），11 → 0 恰好接上周期。
 *
 * 用法：node tests/gen-images.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const CHROME =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'fixtures');

export const BAR_WIDTH = 3;
export const BAR_COUNT = 12;
export const BAND = BAR_WIDTH * BAR_COUNT; // 36
export const BAR_COLORS = ['#e01b1b', '#f2c200', '#1f5fd0']; // 红 / 黄 / 蓝

const LAUNCH_ARGS = [
  '--allow-file-access-from-files',
  '--hide-scrollbars',
  '--force-color-profile=srgb',
  '--disable-lcd-text',
];

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: LAUNCH_ARGS,
    defaultViewport: { width: 1200, height: 900 },
  });

  try {
    const page = await browser.newPage();
    await page.goto('about:blank');

    const payload = await page.evaluate(
      ({ band, barWidth, barCount, barColors }) => {
        const mk = (w, h) => {
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          return c;
        };

        /** 画封面 */
        function drawCover() {
          const W = 1850;
          const H = 2600;
          const c = mk(W, H);
          const g = c.getContext('2d');

          // 底色
          g.fillStyle = '#efe7d6';
          g.fillRect(0, 0, W, H);

          // 明显边框
          g.strokeStyle = '#26313f';
          g.lineWidth = 28;
          g.strokeRect(14, 14, W - 28, H - 28);

          // 100px 网格
          g.strokeStyle = 'rgba(46, 78, 116, 0.22)';
          g.lineWidth = 2;
          g.beginPath();
          for (let x = 100; x < W; x += 100) {
            g.moveTo(x + 0.5, 0);
            g.lineTo(x + 0.5, H);
          }
          for (let y = 100; y < H; y += 100) {
            g.moveTo(0, y + 0.5);
            g.lineTo(W, y + 0.5);
          }
          g.stroke();

          // 左上角方位标记（判断贴图有没有翻转/旋转）
          g.fillStyle = '#c1121f';
          g.beginPath();
          g.arc(210, 210, 86, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = '#ffffff';
          g.font = 'bold 64px "Helvetica Neue", Arial, sans-serif';
          g.textAlign = 'center';
          g.textBaseline = 'middle';
          g.fillText('TL', 210, 214);

          // 右下角文字标记
          g.fillStyle = '#1b2a3a';
          g.textAlign = 'right';
          g.textBaseline = 'alphabetic';
          g.font = 'bold 118px "Helvetica Neue", Arial, sans-serif';
          g.fillText('COVER 1850x2600', W - 84, H - 300);
          g.font = '60px "Helvetica Neue", Arial, sans-serif';
          g.fillText('185 x 260 mm', W - 84, H - 210);

          // 右边缘竖彩条（12 道，等宽，紧贴右边缘，整条带 36px < 40px）
          for (let i = 0; i < barCount; i++) {
            g.fillStyle = barColors[i % 3];
            g.fillRect(W - band + i * barWidth, 0, barWidth, H);
          }
          return c;
        }

        /** 画书脊 */
        function drawSpine(good = true) {
          const W = good ? 100 : 100;
          const H = good ? 2600 : 1000;
          const c = mk(W, H);
          const g = c.getContext('2d');

          g.fillStyle = good ? '#2f6b4f' : '#8a4b2a';
          g.fillRect(0, 0, W, H);

          if (good) {
            // 与封面右边缘完全同相位、同宽度的彩条，画在左边缘
            for (let i = 0; i < barCount; i++) {
              g.fillStyle = barColors[i % 3];
              g.fillRect(i * barWidth, 0, barWidth, H);
            }
            // 竖向书脊文字（非彩条区域），便于肉眼认出这面是书脊
            g.save();
            g.translate(W * 0.62, H * 0.5);
            g.rotate(-Math.PI / 2);
            g.fillStyle = '#f4f9f6';
            g.font = 'bold 46px "Helvetica Neue", Arial, sans-serif';
            g.textAlign = 'center';
            g.textBaseline = 'middle';
            g.fillText('SPINE 10 x 260 mm', 0, 0);
            g.restore();
          } else {
            // 1:10 的错误图
            g.fillStyle = '#f7e9dc';
            g.font = 'bold 34px "Helvetica Neue", Arial, sans-serif';
            g.textAlign = 'center';
            g.textBaseline = 'middle';
            g.fillText('BAD', W / 2, H / 2 - 40);
            g.font = 'bold 26px "Helvetica Neue", Arial, sans-serif';
            g.fillText('1 : 10', W / 2, H / 2 + 20);
          }
          return c;
        }

        /** 自定义背景 */
        function drawBg() {
          const W = 1600;
          const H = 1200;
          const c = mk(W, H);
          const g = c.getContext('2d');

          // 中心青绿
          g.fillStyle = '#0f6f7a';
          g.fillRect(0, 0, W, H);

          // 斜向浅条纹
          g.save();
          g.globalAlpha = 0.12;
          g.strokeStyle = '#ffffff';
          g.lineWidth = 26;
          for (let x = -H; x < W + H; x += 120) {
            g.beginPath();
            g.moveTo(x, 0);
            g.lineTo(x + H, H);
            g.stroke();
          }
          g.restore();

          // 橙色粗边框（导出后四角应仍是橙色，便于确认背景真的用上了）
          g.strokeStyle = '#ff8a00';
          g.lineWidth = 140;
          g.strokeRect(70, 70, W - 140, H - 140);

          // 中心白框 + 文字
          g.fillStyle = 'rgba(255,255,255,0.92)';
          g.fillRect(W / 2 - 380, H / 2 - 90, 760, 180);
          g.fillStyle = '#0f3d44';
          g.font = 'bold 84px "Helvetica Neue", Arial, sans-serif';
          g.textAlign = 'center';
          g.textBaseline = 'middle';
          g.fillText('CUSTOM BG', W / 2, H / 2);
          return c;
        }

        const out = {};
        out['cover-1850x2600.png'] = drawCover().toDataURL('image/png');
        out['spine-100x2600.png'] = drawSpine(true).toDataURL('image/png');
        out['spine-bad-100x1000.png'] = drawSpine(false).toDataURL('image/png');
        out['bg-custom-1600x1200.png'] = drawBg().toDataURL('image/png');
        return out;
      },
      { band: BAND, barWidth: BAR_WIDTH, barCount: BAR_COUNT, barColors: BAR_COLORS },
    );

    for (const [name, dataURL] of Object.entries(payload)) {
      const b64 = String(dataURL).split(',')[1];
      if (!b64) throw new Error(`empty dataURL for ${name}`);
      const file = path.join(OUT_DIR, name);
      fs.writeFileSync(file, Buffer.from(b64, 'base64'));
      const kb = (fs.statSync(file).size / 1024).toFixed(0);
      console.log(`✓ ${name.padEnd(26)} ${kb} KB`);
    }
    console.log(`\nfixtures → ${OUT_DIR}`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error('gen-images failed:', e);
  process.exit(1);
});
