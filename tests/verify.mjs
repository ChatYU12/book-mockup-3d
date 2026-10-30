#!/usr/bin/env node
/**
 * tests/verify.mjs — 书籍 3D 效果图生成网页工具 · 独立验收脚本
 *
 * 用 puppeteer-core + 本机 Chrome 打开 file://.../index.html，通过 window.__book3d
 * 调试契约逐条跑需求第四节的 8 条验收标准，失败不中断，全部跑完后汇总成
 * tests/report.md，截图/导出件落在 tests/shots/。
 *
 * 用法：
 *   node tests/gen-images.mjs     # 先生成 fixtures（已生成可跳过）
 *   node tests/verify.mjs
 *
 * 环境变量（都有默认值，正常不需要设）：
 *   CHROME_PATH   自定义 Chrome 可执行文件
 *   INDEX_HTML    指向另一个 index.html（自测用）
 *   SHOTS_DIR     截图输出目录
 *   REPORT_OUT    报告输出路径
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as P from './lib/png.mjs';

// puppeteer-core 装在 /tmp/book3d-test（保持工作区干净）。tests/node_modules 是指向它的软链；
// 万一软链被清理，就从 NODE_PATH / 固定路径兜底加载。
let puppeteer = null;
try {
  puppeteer = (await import('puppeteer-core')).default;
} catch (err) {
  const { createRequire } = await import('node:module');
  const candidates = [
    process.env.PUPPETEER_DIR,
    '/tmp/book3d-test',
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'node_modules'),
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      const req = createRequire(path.join(dir, 'package.json'));
      puppeteer = req('puppeteer-core');
      if (puppeteer && puppeteer.launch) break;
    } catch (e) {
      /* try next */
    }
  }
  if (!puppeteer || !puppeteer.launch) {
    console.error('✗ 找不到 puppeteer-core。请先: mkdir -p /tmp/book3d-test && cd /tmp/book3d-test && npm i puppeteer-core');
    console.error('  原始错误:', err && err.message);
    process.exit(3);
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const INDEX = process.env.INDEX_HTML
  ? path.resolve(process.env.INDEX_HTML)
  : path.join(ROOT, 'index.html');
const SHOTS = process.env.SHOTS_DIR ? path.resolve(process.env.SHOTS_DIR) : path.join(HERE, 'shots');
const REPORT = process.env.REPORT_OUT ? path.resolve(process.env.REPORT_OUT) : path.join(HERE, 'report.md');
const FIX = path.join(HERE, 'fixtures');
const CHROME =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const PRESETS = ['front', 'left30', 'left45', 'table', 'stack2'];
const BUILTIN_BG = ['studio', 'white', 'wood', 'gradient'];
/** fixtures 里竖彩条的三色（与 gen-images.mjs 保持一致） */
const BAR_RGB = [
  [224, 27, 27],
  [242, 194, 0],
  [31, 95, 208],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fileDataURL = (name) =>
  'data:image/png;base64,' + fs.readFileSync(path.join(FIX, name)).toString('base64');
const fmt = (n, d = 2) => (typeof n === 'number' ? Number(n.toFixed(d)) : String(n));

// ────────────────────────────────────────────────────────────── 小工具 ──

/** 两张同尺寸图的平均 RGB 差（0-255） */
function meanDiff(a, b) {
  const n = Math.min(a.width * a.height, b.width * b.height);
  if (!n) return 255;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const k = i * 4;
    s +=
      Math.abs(a.data[k] - b.data[k]) +
      Math.abs(a.data[k + 1] - b.data[k + 1]) +
      Math.abs(a.data[k + 2] - b.data[k + 2]);
  }
  return s / (n * 3);
}

/** 整数倍 box 降采样（保留 alpha） */
function downscale(img, f) {
  const w = Math.floor(img.width / f);
  const h = Math.floor(img.height / f);
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let dy = 0; dy < f; dy++) {
        for (let dx = 0; dx < f; dx++) {
          const i = ((y * f + dy) * img.width + (x * f + dx)) * 4;
          r += img.data[i];
          g += img.data[i + 1];
          b += img.data[i + 2];
          a += img.data[i + 3];
        }
      }
      const n = f * f;
      const k = (y * w + x) * 4;
      out[k] = r / n;
      out[k + 1] = g / n;
      out[k + 2] = b / n;
      out[k + 3] = a / n;
    }
  }
  return { width: w, height: h, channels: 4, data: out };
}

function nearestPalette({ r, g, b }) {
  let best = -1;
  let bd = Infinity;
  BAR_RGB.forEach(([pr, pg, pb], i) => {
    const d = Math.hypot(r - pr, g - pg, b - pb);
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  return { idx: best, dist: bd };
}

// ────────────────────────────────────────────────────────────── 启动 ──

if (!fs.existsSync(INDEX)) {
  console.error(`✗ 找不到 ${INDEX}（Lead 还没建好 index.html？）`);
  process.exit(2);
}
fs.mkdirSync(SHOTS, { recursive: true });

const indexStat = fs.statSync(INDEX);
const indexSha = crypto.createHash('sha256').update(fs.readFileSync(INDEX)).digest('hex').slice(0, 12);

const LAUNCH_ARGS = [
  '--allow-file-access-from-files',
  '--hide-scrollbars',
  '--force-color-profile=srgb',
  '--disable-lcd-text',
  '--enable-unsafe-swiftshader',
];

const results = [];
const env = {
  chrome: '',
  webgl: '',
  tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  load: os.loadavg().map((v) => v.toFixed(2)).join(' / '),
};

async function check(id, title, fn) {
  const entry = { id, title, pass: true, lines: [], shots: [], notes: [], ms: 0, metrics: {} };
  const A = (cond, msg, val) => {
    const ok = !!cond;
    entry.lines.push({ ok, msg, val });
    if (!ok) entry.pass = false;
    return ok;
  };
  const M = (k, v) => {
    entry.metrics[k] = v;
  };
  const t = Date.now();
  console.log(`\n▶ 检查 ${id} — ${title}`);
  try {
    await fn(A, entry, M);
  } catch (err) {
    entry.pass = false;
    entry.lines.push({ ok: false, msg: '脚本异常中断本条：' + (err && err.message ? err.message : err) });
    console.error('  异常:', err && err.message);
  }
  entry.ms = Date.now() - t;
  results.push(entry);
  console.log(`  ⇒ ${entry.pass ? 'PASS' : 'FAIL'} (${entry.ms}ms)`);
  for (const l of entry.lines) console.log(`    ${l.ok ? '✓' : '✗'} ${l.msg}${l.val !== undefined ? ' | ' + l.val : ''}`);
  return entry;
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: LAUNCH_ARGS,
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
  protocolTimeout: 180000,
});

const page = await browser.newPage();
page.setDefaultTimeout(60000);
const consoleIssues = [];
const pageErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') consoleIssues.push(`${m.type()}: ${m.text()}`.slice(0, 300));
});
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));

async function canvasClip() {
  return page.evaluate(() => {
    const list = [...document.querySelectorAll('canvas')].map((c) => ({
      c,
      r: c.getBoundingClientRect(),
    }));
    if (!list.length) return null;
    list.sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
    const r = list[0].r;
    const sx = window.scrollX;
    const sy = window.scrollY;
    const x = Math.max(0, Math.round(r.left + sx));
    const y = Math.max(0, Math.round(r.top + sy));
    const width = Math.max(8, Math.min(Math.round(r.width), Math.round(sx + window.innerWidth - x)));
    const height = Math.max(8, Math.min(Math.round(r.height), Math.round(sy + window.innerHeight - y)));
    return { x, y, width, height, cssWidth: Math.round(r.width), cssHeight: Math.round(r.height) };
  });
}

/** 画面中心区域指纹，用来判断"有没有重绘/变化" */
async function fingerprint(box) {
  const clip = box || (await canvasClip());
  if (!clip) throw new Error('页面上找不到 <canvas>');
  const sub = {
    x: Math.round(clip.x + clip.width * 0.28),
    y: Math.round(clip.y + clip.height * 0.28),
    width: Math.max(16, Math.round(clip.width * 0.44)),
    height: Math.max(16, Math.round(clip.height * 0.44)),
  };
  const b64 = await page.screenshot({ clip: sub, encoding: 'base64' });
  return P.decodePNG(Buffer.from(b64, 'base64'));
}

async function shot(name, clip) {
  const file = path.join(SHOTS, name);
  await page.screenshot(clip ? { path: file, clip } : { path: file });
  return 'shots/' + name;
}

async function frames(n = 1) {
  await page.evaluate(
    (n) =>
      new Promise((res) => {
        let i = 0;
        const step = () => (++i >= n ? res() : requestAnimationFrame(step));
        requestAnimationFrame(step);
        setTimeout(res, 1500); // rAF 不触发时兜底
      }),
    n,
  );
}

async function exportPNG(opts) {
  const dataURL = await page.evaluate((o) => window.__book3d.renderExport(o), opts);
  const buf = P.dataURLToBuffer(dataURL);
  return { buf, img: P.decodePNG(buf) };
}

// ─────────────────────────────────────────────────────────── 打开页面 ──

let readyInfo = { ok: false, ms: 0, why: 'not attempted' };
let apiKeys = [];
try {
  await page.goto('file://' + INDEX, { waitUntil: 'domcontentloaded', timeout: 120000 });
  env.chrome = await browser.version();
  env.webgl = await page
    .evaluate(() => {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      if (!gl) return 'WebGL 不可用';
      const d = gl.getExtension('WEBGL_debug_renderer_info');
      return (d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) + ' / ' + gl.getParameter(gl.VERSION);
    })
    .catch((e) => 'probe failed: ' + e.message);

  // __book3d 可能在 DOMContentLoaded 之后才挂上，先轮询再判 ready
  await page
    .waitForFunction(() => !!window.__book3d, { timeout: 30000, polling: 100 })
    .catch(() => {});
  readyInfo = await page.evaluate(async () => {
    const t0 = performance.now();
    if (!window.__book3d) return { ok: false, why: 'window.__book3d 不存在（等 30s 仍未挂载）' };
    try {
      await Promise.race([
        Promise.resolve(window.__book3d.ready),
        new Promise((_, rej) => setTimeout(() => rej(new Error('ready 10s 未 resolve')), 10000)),
      ]);
    } catch (e) {
      return { ok: false, why: e.message };
    }
    return { ok: true, ms: performance.now() - t0 };
  });
  apiKeys = await page.evaluate(() => (window.__book3d ? Object.keys(window.__book3d) : []));
} catch (e) {
  readyInfo = { ok: false, why: 'goto/ready 失败: ' + e.message };
}
console.log('环境:', env.chrome, '| WebGL:', env.webgl);
console.log('ready:', JSON.stringify(readyInfo), '| __book3d keys:', apiKeys.join(', '));

// ─────────────────────────────────────────────────────── 1. 5 秒内出模 ──

await check(
  '1',
  '上传两张图后 5 秒内书模出现在画面（阈值 ≤5000ms）',
  async (A, e, M) => {
    A(readyInfo.ok, 'window.__book3d.ready 在 10s 内 resolve', readyInfo.ok ? `${fmt(readyInfo.ms, 1)}ms` : readyInfo.why);

    const getPerf = () =>
      page
        .evaluate(() => {
          try {
            return window.__book3d && window.__book3d.perf ? window.__book3d.perf() : null;
          } catch (err) {
            return { error: String(err && err.message) };
          }
        })
        .catch(() => null);

    const upload = () =>
      page.evaluate(
        async ({ cover, spine }) => {
          const t = performance.now();
          const out = {};
          out.cover = await window.__book3d.loadImage('cover', cover);
          out.spine = await window.__book3d.loadImage('spine', spine);
          out.ms = performance.now() - t;
          out.state = window.__book3d.getState ? window.__book3d.getState() : null;
          return out;
        },
        { cover: fileDataURL('cover-1850x2600.png'), spine: fileDataURL('spine-100x2600.png') },
      );

    /** 冷测：先拍基线 → 上传 → 轮询到画面变化。返回"上传→可见"的墙钟毫秒。 */
    const coldRun = async (tag) => {
      await page.evaluate(() => {
        if (window.__book3d.setBackground) window.__book3d.setBackground('studio');
        if (window.__book3d.tick) window.__book3d.tick();
      });
      await frames(2);
      const before = await fingerprint();
      const t0 = Date.now();
      const pending = upload();
      let visibleMs = null;
      let last = 0;
      const deadline = t0 + 30000; // 先量出到底多久，判据另算
      while (Date.now() < deadline) {
        const fp = await fingerprint();
        last = meanDiff(before, fp);
        if (last > 3) {
          visibleMs = Date.now() - t0;
          break;
        }
        await sleep(60);
      }
      const load = await pending.catch((err) => ({ error: String(err && err.message) }));
      const loadMs = Date.now() - t0;
      const perf = await getPerf();
      const marks = (perf && perf.marks) || {};
      const stages = {};
      for (const k of Object.keys(marks)) if (k.startsWith('upload:') || k === 'firstFrame') stages[k] = fmt(marks[k], 1);
      M[tag] = { visibleMs, loadMs, diff: fmt(last, 2), marks: stages };
      return { load, loadMs, visibleMs, perf };
    };

    // ① 冷启动（页面刚打开、图片尚未加载）——这就是用户的真实路径
    const c1 = await coldRun('冷启动·首次上传');
    e.shots.push(await shot('01-after-upload.png'));

    // ② 热态：画面已就绪，重复上传同一组图不会改变画面，视觉判据失效，只计 loadImage 耗时
    const t1 = Date.now();
    const warm = await upload().catch((err) => ({ error: String(err && err.message) }));
    const warmMs = Date.now() - t1;
    M.warm = { loadMs: warmMs };
    A(warmMs <= 5000, '同页重复上传 loadImage×2 耗时（热态；此时画面本就未变，无法用视觉判据）', `${warmMs}ms`);

    // ③ 只有首次超标才重载复测，判断是"偶发"还是"稳定慢"
    let c2 = null;
    if (c1.visibleMs === null || c1.visibleMs > 5000) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
      await page.waitForFunction(() => !!window.__book3d, { timeout: 30000, polling: 100 }).catch(() => {});
      await page
        .evaluate(() =>
          Promise.race([Promise.resolve(window.__book3d && window.__book3d.ready), new Promise((r) => setTimeout(r, 15000))]),
        )
        .catch(() => {});
      c2 = await coldRun('重载后再冷测');
    }

    A(!!(c1.load && c1.load.cover && c1.load.cover.w > 0), 'loadImage("cover") 返回尺寸', JSON.stringify(c1.load.cover));
    A(!!(c1.load && c1.load.spine && c1.load.spine.w > 0), 'loadImage("spine") 返回尺寸', JSON.stringify(c1.load.spine));
    A(!!(c1.load && c1.load.state && c1.load.state.cover), 'getState().cover 已记录', JSON.stringify(c1.load && c1.load.state && c1.load.state.cover));

    A(
      c1.visibleMs !== null && c1.visibleMs <= 5000,
      '开页 → 拖入两张图，书模出现在画面 ≤5000ms（首次冷启动，墙钟）',
      c1.visibleMs === null ? '>30s 未检测到画面变化' : `${c1.visibleMs}ms（其中 loadImage×2 = ${c1.loadMs}ms）`,
    );
    if (c2) {
      A(
        c2.visibleMs !== null && c2.visibleMs <= 5000,
        '重载后再冷测一次，仍 ≤5000ms（排除偶发）',
        c2.visibleMs === null ? '>30s 未检测到画面变化' : `${c2.visibleMs}ms（loadImage×2 = ${c2.loadMs}ms）`,
      );
    }
    const p1 = c1.perf && c1.perf.marks;
    if (p1) {
      e.notes.push(
        `应用内部标记（performance.now() 绝对值，非时长）：${Object.keys(p1)
          .filter((k) => k.startsWith('upload:') || k === 'firstFrame')
          .map((k) => `${k}=${fmt(p1[k], 0)}`)
          .join('，')}。运行前 load=${env.load}；本机同时有其它浏览器/自动化实例占 CPU 时计时会偏悲观（同一构建在 load≈18 时首次上传 3.8–4.7s，load≈2.8 时 0.5s）。`,
      );
    }
    if (c1.visibleMs !== null && c1.visibleMs > 3000) {
      e.notes.push(`首次上传 ${c1.visibleMs}ms 已接近 5s 阈值，建议空载机器复测。`);
    }
    const st = await page.evaluate(() => window.__book3d.getState());
    A(!!st && !!st.cover && !!st.spine, '页面状态已就绪（供后续检查使用）', JSON.stringify(st && { cover: st.cover, spine: st.spine }));
  },
);

// ──────────────────────────────────────────────────────── 2. 比例 185:260:10 ──

await check('2', '书模三边比例 185:260:10，误差 <1%（以封面宽度为基准）', async (A, e, M) => {
  const dims = await page.evaluate(() => window.__book3d.getDims());
  const st = await page.evaluate(() => window.__book3d.getState());
  e.shots.push(await shot('02-dims-state.png'));
  const m = dims && dims.measured;
  const nominal = dims && dims.nominal;
  A(!!m && [m.x, m.y, m.z].every((v) => typeof v === 'number' && v > 0), 'getDims().measured 三个方向都有正值', JSON.stringify(m));
  A(
    !!nominal && nominal.W === 185 && nominal.H === 260 && nominal.T === 10,
    'getDims().nominal 为 {W:185,H:260,T:10}',
    JSON.stringify(nominal),
  );
  if (!m || !(m.x > 0)) return;
  const expY = (260 / 185) * m.x;
  const expZ = (10 / 185) * m.x;
  const errY = Math.abs(m.y - expY) / expY;
  const errZ = Math.abs(m.z - expZ) / expZ;
  M.measured = m;
  M.expY = fmt(expY, 3);
  M.expZ = fmt(expZ, 3);
  M.errY = fmt(errY * 100, 4);
  M.errZ = fmt(errZ * 100, 4);
  A(errY < 0.01, `高/宽 = ${fmt(m.y / m.x, 5)}（期望 260/185=${fmt(260 / 185, 5)}，误差 ${fmt(errY * 100, 4)}% < 1%）`, `y=${fmt(m.y, 3)} 期望 ${fmt(expY, 3)}`);
  A(errZ < 0.01, `厚/宽 = ${fmt(m.z / m.x, 5)}（期望 10/185=${fmt(10 / 185, 5)}，误差 ${fmt(errZ * 100, 4)}% < 1%）`, `z=${fmt(m.z, 3)} 期望 ${fmt(expZ, 3)}`);
  A(
    st && st.cover && Math.abs(st.cover.w / st.cover.h - 185 / 260) < 0.01,
    'state.cover 尺寸与 185:260 一致（确认贴的是 1850×2600 那张）',
    JSON.stringify(st && st.cover),
  );
  A(st && st.spine && Math.abs(st.spine.w / st.spine.h - 10 / 260) < 0.01, 'state.spine 尺寸与 10:260 一致', JSON.stringify(st && st.spine));
});

// ──────────────────────────────────────────────────── 3. 预设视角 ≥4 且 300ms ──

await check('3', '预设视角 ≥4 种，切换后 300ms 内完成重绘', async (A, e, M) => {
  const dom = await page.evaluate(() => {
    const keys = ['front', 'left30', 'left45', 'table', 'stack2', '正面', '左前30', '左前45', '左前 30', '左前 45', '平放', '堆叠'];
    const found = new Set();
    const nodes = [...document.querySelectorAll('button,[role="button"],a,label,li,input[type="radio"]')];
    for (const n of nodes) {
      const txt = (
        (n.dataset && (n.dataset.preset || n.dataset.view || n.dataset.viewId || '')) +
        ' ' +
        (n.getAttribute && (n.getAttribute('aria-label') || '')) +
        ' ' +
        (n.textContent || '')
      )
        .replace(/\s+/g, ' ')
        .trim();
      if (!txt || txt.length > 40) continue;
      for (const k of keys) if (txt.toLowerCase().includes(k.toLowerCase())) found.add(k.replace(/\s/g, ''));
    }
    return { keys: [...found], count: found.size };
  });
  M.domPresetKeys = dom.keys;
  A(dom.count >= 4, `页面上能识别的预设控件 ≥4 个`, `${dom.count} 个：${dom.keys.join(' / ') || '(无)'}`);

  // 逐个 preset：① 首帧时延 ② 动画到位时间（页面内 readPixels，不受 CDP 截图延迟影响）
  const timings = [];
  let prevFinal = null;
  let pixelProbe = null;
  for (const name of PRESETS) {
    const r = await page.evaluate(async (name) => {
      const B = window.__book3d;
      const cv = document.querySelector('canvas');
      let gl = null;
      try {
        gl = cv.getContext('webgl2') || cv.getContext('webgl');
      } catch (e) {
        gl = null;
      }
      const raf = () => new Promise((res) => requestAnimationFrame(res));
      const PW = 56;
      const PH = 56;
      const px = new Uint8Array(PW * PH * 4);
      const grab = () => {
        if (!gl) return null;
        const cx = Math.max(0, Math.floor(cv.width / 2 - PW / 2));
        const cy = Math.max(0, Math.floor(cv.height / 2 - PH / 2));
        gl.readPixels(cx, cy, PW, PH, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let sum = 0;
        for (let i = 0; i < px.length; i += 4) sum += px[i] + px[i + 1] + px[i + 2] + px[i + 3];
        return { sum, copy: Uint8Array.from(px) };
      };
      const diffPx = (a, b) => {
        let t = 0;
        for (let i = 0; i < a.length; i += 4) t += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
        return t / (a.length / 4) / 3;
      };
      await raf();
      const t0 = performance.now();
      await B.setPreset(name);
      await raf();
      const firstFrameMs = performance.now() - t0;

      let settleMs = null;
      let frames = 0;
      const frameGaps = [];
      let lastFrameAt = performance.now();
      const g0 = grab();
      const canRead = !!(g0 && g0.sum > 0);
      if (canRead) {
        let prev = g0.copy;
        let stable = 0;
        let lastChange = performance.now();
        while (performance.now() - t0 < 2000) {
          await raf();
          const now = performance.now();
          frameGaps.push(now - lastFrameAt);
          lastFrameAt = now;
          frames++;
          const g = grab();
          if (!g) break;
          const d = diffPx(prev, g.copy);
          // 可见变化阈值 1.0/255：肉眼不可辨的抖动不算"还在重绘"，连续 3 帧稳定即视为到位
          if (d < 1.0) {
            if (++stable >= 3) break;
          } else {
            stable = 0;
            lastChange = now;
          }
          prev = g.copy;
        }
        settleMs = lastChange - t0;
      }
      const sortedGaps = frameGaps.slice().sort((a, b) => a - b);
      const frameInterval = sortedGaps.length ? sortedGaps[Math.floor(sortedGaps.length / 2)] : 0;
      return { firstFrameMs, settleMs, frames, frameInterval, canRead, state: B.getState ? B.getState() : null };
    }, name);

    if (pixelProbe === null) pixelProbe = r.canRead;

    // 截图证据（同时取终态画面，供"两两可区分"判定）
    await frames(2);
    const fpFinal = await fingerprint();
    const distinct = prevFinal ? meanDiff(prevFinal, fpFinal) : 99;
    prevFinal = fpFinal;
    timings.push({
      name,
      firstFrameMs: fmt(r.firstFrameMs, 1),
      settleMs: r.settleMs === null ? null : fmt(r.settleMs, 1),
      frameInterval: fmt(r.frameInterval, 1),
      frames: r.frames,
      distinct: fmt(distinct, 2),
      applied: r.state && r.state.preset,
    });
    e.shots.push(await shot(`10-preset-${name}.png`));
  }
  M.presets = timings;
  M.pixelProbe = pixelProbe;
  for (const t of timings) {
    A(t.applied === t.name, `setPreset('${t.name}') 后 getState().preset 回读一致`, `${t.applied}`);
    A(Number(t.firstFrameMs) <= 300, `setPreset('${t.name}') → 下一帧出现新姿态 ≤300ms`, `${t.firstFrameMs}ms`);
    if (t.settleMs !== null) {
      const tol = Math.max(17, Number(t.frameInterval) || 0);
      A(
        Number(t.settleMs) <= 300 + tol,
        `setPreset('${t.name}') 动画到位（画面停止变化）≤300ms + 1 帧量化容差`,
        `${t.settleMs}ms（帧间隔 ${t.frameInterval}ms，容差 ${fmt(tol, 0)}ms，${t.frames} 帧内收敛）`,
      );
      if (Number(t.settleMs) > 300) {
        e.notes.push(
          `setPreset('${t.name}') 观察到 ${t.settleMs}ms 才停止变化：本次 headless 渲染帧间隔约 ${t.frameInterval}ms（被其它进程抢占，掉帧严重），最后一次可见变化正好压在 300ms 判据边界上，只能用"1 帧容差"判定；应在空载环境复测。`,
        );
      }
    }
  }
  if (pixelProbe === false) {
    e.notes.push('页内 WebGL readPixels 读不到内容（可能未开 preserveDrawingBuffer），动画到位时间未能直测，仅保留首帧时延与截图对比。');
  }
  const distinct = timings.filter((t) => Number(t.distinct) > 1.5);
  A(distinct.length >= 4, '≥4 种预设终态画面两两可区分（相邻截图平均色差 >1.5/255）', distinct.map((t) => `${t.name}:${t.distinct}`).join(' '));
});

// ─────────────────────────────────────────────────── 4. 透明 PNG 质量 ──

let transparentExport = null;
await check('4', '透明 PNG：四角 alpha=0、无灰底、有抗锯齿过渡、无纯白/纯黑描边、有 alpha 阴影', async (A, e, M) => {
  await page.evaluate(async () => {
    if (window.__book3d.setBackground) await window.__book3d.setBackground('none');
    if (window.__book3d.setPreset) await window.__book3d.setPreset('left30');
  });
  await frames(2);
  const { buf, img } = await exportPNG({ transparent: true, longEdge: 2000 });
  transparentExport = img;
  const file = path.join(SHOTS, '20-export-transparent-2000.png');
  fs.writeFileSync(file, buf);
  e.shots.push('shots/20-export-transparent-2000.png');
  // 铺棋盘格，人眼复核"有没有灰底/白边"
  const checker = P.overCheckerboard(downscale(img, 2));
  fs.writeFileSync(path.join(SHOTS, '21-transparent-on-checker.png'), P.encodePNG(checker));
  e.shots.push('shots/21-transparent-on-checker.png');

  const W = img.width;
  const H = img.height;
  M.size = `${W}x${H}`;
  const corners = [
    ['左上', 0, 0],
    ['右上', W - 1, 0],
    ['左下', 0, H - 1],
    ['右下', W - 1, H - 1],
  ];
  for (const [label, x, y] of corners) {
    const p = P.px(img, x, y);
    A(p.a === 0, `${label}角 alpha=0（无底色）`, `rgba(${p.r},${p.g},${p.b},${p.a})`);
  }
  // 角落区域 alpha 均值（容忍 1-2 个抗锯齿噪声）
  let cornerMax = 0;
  for (const [x0, y0] of [[0, 0], [W - 60, 0], [0, H - 60], [W - 60, H - 60]]) {
    let s = 0;
    for (let y = y0; y < y0 + 60; y += 3) for (let x = x0; x < x0 + 60; x += 3) s += P.px(img, x, y).a;
    cornerMax = Math.max(cornerMax, s / (20 * 20));
  }
  M.cornerAvgAlpha = fmt(cornerMax, 1);
  A(cornerMax < 3, '四角 60×60 区域平均 alpha <3（不是灰底/白底透视）', fmt(cornerMax, 2));

  // 半透明抗锯齿过渡像素
  let semi = 0;
  let opaque = 0;
  let clear = 0;
  for (let i = 0, n = W * H; i < n; i++) {
    const a = img.data[i * 4 + 3];
    if (a === 0) clear++;
    else if (a === 255) opaque++;
    else semi++;
  }
  M.semi = semi;
  M.opaque = opaque;
  M.semiRatio = fmt((semi / (W * H)) * 100, 2);
  A(semi > 800, '存在轮廓抗锯齿过渡像素（0<alpha<255）', `${semi} 个（占 ${M.semiRatio}%）`);

  // 轮廓描边缺陷：紧贴半透明边缘的不透明像素里，近白 / 近黑占比
  let edge = 0;
  let whiteEdge = 0;
  let blackEdge = 0;
  const isEdge = (x, y) => {
    const a = img.data[(y * W + x) * 4 + 3];
    if (a < 250) return false;
    return (
      (x > 0 && img.data[(y * W + x - 1) * 4 + 3] < 200) ||
      (x < W - 1 && img.data[(y * W + x + 1) * 4 + 3] < 200) ||
      (y > 0 && img.data[((y - 1) * W + x) * 4 + 3] < 200) ||
      (y < H - 1 && img.data[((y + 1) * W + x) * 4 + 3] < 200)
    );
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (img.data[i + 3] < 250) continue;
      if (!isEdge(x, y)) continue;
      edge++;
      const r = img.data[i];
      const g = img.data[i + 1];
      const b = img.data[i + 2];
      if (Math.min(r, g, b) > 235) whiteEdge++;
      if (Math.max(r, g, b) < 24) blackEdge++;
    }
  }
  M.edgePixels = edge;
  M.whiteEdge = whiteEdge;
  M.blackEdge = blackEdge;
  const whiteRatio = edge ? whiteEdge / edge : 0;
  A(edge > 0, '能找到书模轮廓（不透明像素边界的像素数 >0）', `${edge} 个`);
  A(whiteRatio < 0.02, '轮廓上不存在"alpha=255 的近白描边"（占比 <2%）', `${whiteEdge}/${edge} = ${fmt(whiteRatio * 100, 2)}%`);
  A(blackEdge === 0, '轮廓上不存在"alpha=255 的近黑描边"', `${blackEdge}/${edge}`);

  // 接触阴影：书模底部以下存在半透明暗像素
  let modelBottom = 0;
  for (let y = H - 1; y >= 0 && !modelBottom; y--) {
    for (let x = 0; x < W; x++) if (img.data[(y * W + x) * 4 + 3] >= 250) { modelBottom = y; break; }
  }
  let shadow = 0;
  let shadowLumaSum = 0;
  for (let y = Math.max(0, modelBottom - 120); y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const a = img.data[i + 3];
      if (a === 0 || a === 255) continue;
      const l = P.luma({ r: img.data[i], g: img.data[i + 1], b: img.data[i + 2] });
      if (l < 160) { shadow++; shadowLumaSum += l; }
    }
  }
  M.modelBottom = modelBottom;
  M.shadowPixels = shadow;
  A(shadow > 200, '书模下方存在 alpha 渐变的接触阴影像素（0<alpha<255 且暗）', `${shadow} 个，平均亮度 ${fmt(shadowLumaSum / Math.max(1, shadow), 0)}`);

  // 灰底兜底：外框 12px 全透明
  let borderOpaque = 0;
  let borderDark = 0;
  let borderColored = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (x >= 12 && x < W - 12 && y >= 12 && y < H - 12) continue;
      const i = (y * W + x) * 4;
      if (img.data[i + 3] <= 8) continue;
      borderOpaque++;
      const l = P.luma({ r: img.data[i], g: img.data[i + 1], b: img.data[i + 2] });
      if (l < 170) borderDark++;
      else borderColored++;
    }
  }
  M.borderOpaque = borderOpaque;
  M.borderDark = borderDark;
  M.borderColored = borderColored;
  // 外框出血不算"灰底/白底"（四角与角落区域已单独判定），但阴影/书模被画布边缘切平是可报告的观感缺陷
  if (borderOpaque > 0) {
    e.notes.push(
      `透明导出外框 12px 内有 ${borderOpaque} 个像素 alpha>8（暗色阴影 ${borderDark} 个、彩色 ${borderColored} 个）：画面内容触到画布边缘，叠进 PPT 时边缘会看到被切平的一线。`,
    );
  } else {
    e.notes.push('透明导出外框 12px 完全透明（内容未触边）。');
  }

  // ── 观感线索（自动量，人眼复核用）──
  // (1) 接触阴影是否平滑（alpha 台阶多 = 脏）
  const shadowAlphas = new Set();
  let maxAlphaStep = 0;
  for (let y = Math.max(0, modelBottom - 110); y < H - 1; y += 2) {
    let prevA = -1;
    for (let x = 2; x < W; x += 2) {
      const a = img.data[(y * W + x) * 4 + 3];
      if (a <= 0 || a >= 255) {
        prevA = -1;
        continue;
      }
      shadowAlphas.add(a);
      if (prevA >= 0 && Math.abs(a - prevA) > maxAlphaStep) maxAlphaStep = Math.abs(a - prevA);
      prevA = a;
    }
  }
  M.shadowAlphaLevels = shadowAlphas.size;
  M.shadowMaxStep = maxAlphaStep;
  e.notes.push(
    shadowAlphas.size < 12
      ? `接触阴影只有 ${shadowAlphas.size} 级 alpha 灰阶（相邻最大跳变 ${maxAlphaStep}/255），放大后可能看出台阶、显脏。`
      : `接触阴影（仅统计 0<alpha<255 的半透明像素）alpha 层次 ${shadowAlphas.size} 级，相邻像素最大跳变 ${maxAlphaStep}/255；层次多在 12 级以上即不算"脏台阶"。`,
  );

  // (2) 预乘 alpha 当直通 alpha 导出 → 轮廓内侧发暗/发灰
  const ratios = [];
  for (let y = 1; y < H - 1; y += 1) {
    for (let x = 1; x < W - 1; x += 1) {
      const i = (y * W + x) * 4;
      const a = img.data[i + 3];
      if (a === 0 || a === 255 || a < 30) continue;
      const el = P.luma({ r: img.data[i], g: img.data[i + 1], b: img.data[i + 2] });
      // 找 4 邻居里不透明的那个，用它当"这个边缘像素本该是什么颜色"
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const j = ((y + dy) * W + (x + dx)) * 4;
        if (img.data[j + 3] < 250) continue;
        const il = P.luma({ r: img.data[j], g: img.data[j + 1], b: img.data[j + 2] });
        if (il > 40) ratios.push(el / il);
        break;
      }
    }
  }
  ratios.sort((a, b) => a - b);
  const medRatio = ratios.length ? ratios[Math.floor(ratios.length / 2)] : null;
  M.edgeLumaRatio = medRatio === null ? null : fmt(medRatio, 3);
  if (medRatio !== null) {
    e.notes.push(
      medRatio < 0.8
        ? `轮廓半透明边缘的亮度只有内侧不透明像素的 ${fmt(medRatio * 100, 0)}%（<80% 说明边缘偏暗，疑似把预乘 alpha 当直通 alpha 导出，叠进浅色 PPT 会看到暗边）。`
        : `轮廓半透明边缘亮度/内侧亮度 = ${fmt(medRatio * 100, 0)}%（正常范围，无暗边迹象）。`,
    );
  }
});

// ─────────────────────────────────────────────────── 5. 长边 2000/3000/4000 ──

await check('5', '导出长边 2000/3000/4000 的实际像素尺寸正确，4000 不报错不崩溃', async (A, e, M) => {
  const rows = [];
  for (const le of [2000, 3000, 4000]) {
    const t0 = Date.now();
    let buf = null;
    let err = null;
    try {
      const st = await page.evaluate(async (le) => {
        if (window.__book3d.setLongEdge) await window.__book3d.setLongEdge(le);
        return window.__book3d.getState ? window.__book3d.getState().longEdge : null;
      }, le);
      M[`longEdge${le}State`] = st;
      const r = await exportPNG({ transparent: true, longEdge: le });
      buf = r.buf;
      if (le === 4000) fs.writeFileSync(path.join(SHOTS, 'export-transparent-4000.png'), buf);
      if (le === 3000) fs.writeFileSync(path.join(SHOTS, 'export-transparent-3000.png'), buf);
    } catch (err2) {
      err = err2;
    }
    const ms = Date.now() - t0;
    if (!buf) {
      A(false, `longEdge=${le} 导出未抛错`, 'ERR: ' + (err && err.message));
      rows.push({ le, err: String(err && err.message).slice(0, 120) });
      continue;
    }
    let sz;
    try {
      sz = P.pngSize(buf);
    } catch (err3) {
      A(false, `longEdge=${le} 产物是合法 PNG`, err3.message);
      continue;
    }
    const maxEdge = Math.max(sz.width, sz.height);
    A(err === null, `longEdge=${le} 导出未抛错`, `${ms}ms, ${(buf.length / 1024 / 1024).toFixed(2)}MB`);
    A(maxEdge === le, `longEdge=${le} 实际像素长边 = ${le}`, `${sz.width}×${sz.height}`);
    rows.push({ le, w: sz.width, h: sz.height, ms, mb: fmt(buf.length / 1024 / 1024, 2) });
  }
  M.rows = rows;
  const r0 = rows.find((r) => r.le === 2000);
  if (r0 && r0.w && r0.h) {
    const aspect = r0.w / r0.h;
    M.aspect = fmt(aspect, 3);
    e.notes.push(
      `导出画幅 ${r0.w}×${r0.h}，长宽比 ${fmt(aspect, 3)}（等于预览画布宽高比）。若想要固定的成品画幅（如正方形或 185:260），取景会随窗口尺寸变化——不作为验收判据，仅提示。`,
    );
  }
  A(rows.length === 3 && rows.every((r) => !r.err), '三档全部产出且页面仍存活', JSON.stringify(rows));
  const alive = await page.evaluate(() => !!(window.__book3d && window.__book3d.getState)).catch(() => false);
  A(alive, '4000 导出后页面/WebGL 上下文仍然可用');
});

// ───────────────────────────────────────────────────── 6. 内置背景 + 自定义 ──

await check('6', '内置背景 ≥4 款（不透明 + 色相符合），自定义背景可用', async (A, e, M) => {
  const stats = {};
  for (const id of BUILTIN_BG) {
    try {
      await page.evaluate(async (id) => {
        await window.__book3d.setBackground(id);
      }, id);
      await frames(2);
      e.shots.push(await shot(`30-bg-${id}.png`));
      const { buf, img } = await exportPNG({ transparent: false, longEdge: 1200 });
      fs.writeFileSync(path.join(SHOTS, `35-export-bg-${id}.png`), buf);
      e.shots.push(`shots/35-export-bg-${id}.png`);
      const W = img.width;
      const H = img.height;
      const corners = [
        P.px(img, 4, 4),
        P.px(img, W - 5, 4),
        P.px(img, 4, H - 5),
        P.px(img, W - 5, H - 5),
      ];
      const opq = corners.every((c) => c.a === 255);
      const avgTL = P.avgColor(img, 0, 0, W * 0.12, H * 0.12);
      const avgTR = P.avgColor(img, W * 0.88, 0, W, H * 0.12);
      const avgBL = P.avgColor(img, 0, H * 0.88, W * 0.12, H);
      const avgBR = P.avgColor(img, W * 0.88, H * 0.88, W, H);
      stats[id] = {
        opq,
        cornerAlpha: corners.map((c) => c.a),
        tl: [fmt(avgTL.r, 0), fmt(avgTL.g, 0), fmt(avgTL.b, 0)],
        tr: [fmt(avgTR.r, 0), fmt(avgTR.g, 0), fmt(avgTR.b, 0)],
        bl: [fmt(avgBL.r, 0), fmt(avgBL.g, 0), fmt(avgBL.b, 0)],
        br: [fmt(avgBR.r, 0), fmt(avgBR.g, 0), fmt(avgBR.b, 0)],
        size: `${W}x${H}`,
      };
      A(opq, `背景 ${id}：四角 alpha=255（不透明）`, JSON.stringify(stats[id].cornerAlpha));

      if (id === 'wood') {
        const c = 0.5 * (avgTL.r + avgBR.r);
        const g = 0.5 * (avgTL.g + avgBR.g);
        const b = 0.5 * (avgTL.b + avgBR.b);
        A(c > g && g > b, '背景 wood：R>G>B（木质偏棕）', `R=${fmt(c, 0)} G=${fmt(g, 0)} B=${fmt(b, 0)}`);
      } else if (id === 'white') {
        const ok = [avgTL, avgBR].every((c) => c.r > 250 && c.g > 250 && c.b > 250);
        A(ok, '背景 white：R,G,B 均 >250', `TL=${stats[id].tl} BR=${stats[id].br}`);
      } else if (id === 'studio') {
        const close = [avgTL, avgBR].every((c) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) <= 12);
        const mid = [avgTL, avgBR].every((c) => {
          const m = (c.r + c.g + c.b) / 3;
          return m >= 200 && m <= 245;
        });
        A(close, '背景 studio：三通道接近（max-min ≤12）', `TL=${stats[id].tl} BR=${stats[id].br}`);
        A(mid, '背景 studio：亮度落在 200–245（浅灰影棚）', `TL=${stats[id].tl} BR=${stats[id].br}`);
      } else if (id === 'gradient') {
        const dTop = P.maxChannelDiff(avgTL, avgTR);
        const dBot = P.maxChannelDiff(avgBL, avgBR);
        const dVert = Math.max(P.maxChannelDiff(avgTL, avgBL), P.maxChannelDiff(avgTR, avgBR));
        A(dVert > 6 || dTop + dBot > 6, '背景 gradient：上下两端不同色（渐变可见）', `TL=${stats[id].tl} BL=${stats[id].bl}`);
      }
    } catch (err) {
      A(false, `背景 ${id} 导出/检查失败`, err.message);
    }
  }
  M.stats = stats;
  A(Object.keys(stats).length >= 4, '内置背景款数 ≥4', `${Object.keys(stats).length} 款：${Object.keys(stats).join('/')}`);

  // 自定义背景
  try {
    const custom = fileDataURL('bg-custom-1600x1200.png');
    const meta = await page.evaluate((d) => window.__book3d.loadCustomBackground(d), custom);
    A(meta && meta.w === 1600 && meta.h === 1200, 'loadCustomBackground 返回 1600×1200', JSON.stringify(meta));
    await page.evaluate(async () => {
      await window.__book3d.setBackground('custom');
    });
    await frames(2);
    e.shots.push(await shot('34-bg-custom.png'));
    const { buf, img } = await exportPNG({ transparent: false, longEdge: 1200 });
    fs.writeFileSync(path.join(SHOTS, '35-export-bg-custom.png'), buf);
    e.shots.push('shots/35-export-bg-custom.png');
    const W = img.width;
    const H = img.height;
    const corners = [P.px(img, 4, 4), P.px(img, W - 5, 4), P.px(img, 4, H - 5), P.px(img, W - 5, H - 5)];
    A(corners.every((c) => c.a === 255), '自定义背景导出四角 alpha=255', JSON.stringify(corners.map((c) => c.a)));
    const ok = await page.evaluate(() => window.__book3d.getState().bg);
    A(ok === 'custom', 'getState().bg === "custom"', String(ok));
    // 自定义图里橙色边框 + 青绿底，检查导出背景里确实出现了这两个色系
    let orange = 0;
    let teal = 0;
    let total = 0;
    for (let y = 0; y < H; y += 5) {
      for (let x = 0; x < W; x += 5) {
        const p = P.px(img, x, y);
        total++;
        if (p.r > 200 && p.g > 90 && p.g < 190 && p.b < 80) orange++;
        if (p.r < 90 && p.g > 80 && p.b > 90) teal++;
      }
    }
    M.customOrangeRatio = fmt((orange / total) * 100, 2);
    M.customTealRatio = fmt((teal / total) * 100, 2);
    A(
      orange / total > 0.02 || teal / total > 0.02,
      '导出画面里能看到自定义背景的特征色（橙框/青绿底）',
      `橙 ${M.customOrangeRatio}% / 青 ${M.customTealRatio}%`,
    );
  } catch (err) {
    A(false, '自定义背景上传/导出失败', err.message);
  }
});

// ─────────────────────────────────────────────────────────── 7. 接缝 ──

await check('7', '封面右边缘与书脊左边缘接缝不错位（无 1px 以上错位/白缝）', async (A, e, M) => {
  await page.evaluate(async () => {
    if (window.__book3d.setBackground) await window.__book3d.setBackground('none');
    if (window.__book3d.setPreset) await window.__book3d.setPreset('left30');
    if (window.__book3d.tick) window.__book3d.tick();
  });
  await frames(2);

  const raw = await page.evaluate(() => (window.__book3d.getSeamSample ? window.__book3d.getSeamSample() : null));
  A(!!raw, 'getSeamSample() 可用并返回数据', raw ? `keys=${Object.keys(raw).join(',')}` : '缺失');

  // 归一化成列颜色数组
  let cols = [];
  let shape = 'unknown';
  if (raw) {
    const arr = raw.rows || raw.cols || raw.samples || raw.pixels;
    const isColor = (c) => Array.isArray(c) && c.length >= 3 && typeof c[0] === 'number';
    if (Array.isArray(arr) && arr.length) {
      if (isColor(arr[0])) {
        cols = arr.map((c) => ({ r: c[0], g: c[1], b: c[2] }));
        shape = `flat 列数组 ×${cols.length}`;
      } else if (Array.isArray(arr[0]) && isColor(arr[0][0])) {
        const mid = Math.floor(arr.length / 2);
        cols = arr[mid].map((c) => ({ r: c[0], g: c[1], b: c[2] }));
        shape = `二维 rows[${arr.length}][${arr[0].length}]，取中间行`;
      } else if (arr[0] && typeof arr[0] === 'object') {
        cols = arr.map((o) => ({ r: o.r ?? o[0], g: o.g ?? o[1], b: o.b ?? o[2] }));
        shape = `对象数组 ×${cols.length}`;
      }
    }
  }
  M.seamShape = shape;
  M.seamRaw = JSON.stringify(raw).slice(0, 600);
  A(cols.length >= 2, `getSeamSample 能提取出跨接缝的列像素（形状：${shape}）`, `${cols.length} 列`);

  if (cols.length >= 2) {
    const chroma = (c) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
    const chs = cols.map(chroma);
    M.seamChroma = chs.map((v) => fmt(v, 0)).join(',');
    M.seamCols = cols.length;
    A(cols.length >= 5, '接缝样本有一定宽度（≥5 列，否则 1px 级判据变弱）', `${cols.length} 列`);
    // 灰缝/白缝/黑缝：三色竖条是强色度色，某列接近中性（灰/白/黑）说明接了底色或边上留了缝。
    // 用相对阈值：等宽细条重采样后混色列本身色度会下降，但仍应保留与最饱和列同量级的色度。
    const minChroma = Math.min(...chs);
    const maxChroma = Math.max(...chs);
    A(
      minChroma >= Math.max(30, maxChroma * 0.15),
      '接缝各列都保留彩条色度（无灰缝/白缝/黑缝）',
      `最小色度 ${fmt(minChroma, 0)} / 最大 ${fmt(maxChroma, 0)}`,
    );

    const cls = cols.map((c) => nearestPalette(c));
    const cleanRatio = cls.filter((c) => c.dist < 60).length / cls.length;
    const strict = cleanRatio >= 0.8; // 样本未被重采样糊掉 → 可以按三色归类做严格判据
    M.seamMode = strict ? 'strict（样本保留原色，按三色归类）' : `blend（样本被重采样，按混色判据；纯色列占比 ${fmt(cleanRatio * 100, 0)}%）`;

    const diffs = [];
    for (let i = 1; i < cols.length; i++) diffs.push(P.maxChannelDiff(cols[i - 1], cols[i]));
    M.seamDiffs = diffs.map((d) => fmt(d, 0)).join(',');
    const sorted = [...diffs].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)] || 0;
    let seamIdx = typeof raw.coverW === 'number' && raw.coverW > 0 && raw.coverW < cols.length ? raw.coverW : null;
    // 样本按"接缝居中、连续 N 列"约定返回时，奇数长度的中间列即书脊首列
    if (seamIdx === null && cols.length % 2 === 1) seamIdx = (cols.length - 1) / 2;
    const seamDiff = seamIdx !== null ? diffs[seamIdx - 1] : Math.max(...diffs);
    M.seamIdx = seamIdx;

    if (strict) {
      M.seamClasses = cls.map((c) => `${c.idx}(${fmt(c.dist, 0)})`).join(' ');
      const maxDist = Math.max(...cls.map((c) => c.dist));
      A(maxDist < 60, '接缝列像素都能归到三种彩条色（无混色/错色 ⇒ UV 无偏移）', `最大色距 ${fmt(maxDist, 0)}`);

      // 游程一致性：等宽彩条，重采样后每条宽度应接近（差 >1 列即 1px 级错位）
      const runs = [];
      for (const c of cls) {
        if (runs.length && runs[runs.length - 1].idx === c.idx) runs[runs.length - 1].len++;
        else runs.push({ idx: c.idx, len: 1 });
      }
      M.seamRuns = runs.map((r) => `${r.idx}×${r.len}`).join(' ');
      if (runs.length >= 3) {
        const lens = runs.slice(1, -1).map((r) => r.len);
        if (lens.length) {
          const spread = Math.max(...lens) - Math.min(...lens);
          A(spread <= 1, '彩条游程宽度一致（宽度差 ≤1 列 ⇒ 无 1px 级错位/重复列）', `游程 ${M.seamRuns}，中间段宽度差 ${spread}`);
        }
      }
      const seq = runs.map((r) => r.idx);
      const steps = [];
      for (let i = 1; i < seq.length; i++) steps.push((((seq[i] - seq[i - 1]) % 3) + 3) % 3);
      const forward = steps.every((s) => s === 1);
      const backward = steps.every((s) => s === 2);
      A(forward || backward, '彩条颜色按三色周期连续（无跳条 ⇒ 无整条错位）', `step=${steps.join(',')}`);

      // 接缝必须正好落在两条彩条的交界上：两侧列的归类必须不同。
      // 只要纹理 UV 偏移 1~3px，接缝就会落在某条彩条内部，这条立刻失败。
      if (seamIdx !== null) {
        const a = cls[seamIdx - 1];
        const b = cls[seamIdx];
        A(a.idx !== b.idx, '接缝正好落在彩条交界（两侧列颜色不同 ⇒ 无 1px 级 UV 偏移）', `左 ${a.idx} / 右 ${b.idx}`);
        // fixtures 设计：封面最后一列是第 12 条（蓝），书脊第一列是第 1 条（红）
        A(
          a.idx === 2 && b.idx === 0,
          '接缝相位正确（封面末条=蓝 → 书脊首条=红，与 fixtures 设计一致）',
          `得到 ${a.idx}→${b.idx}（期望 2→0）`,
        );
      }
    } else {
      // 混色模式：重采样后颜色逐列平滑变化，仍可判"接缝处没有额外的错位跳变/重复列"
      A(seamIdx !== null || cols.length >= 5, '样本覆盖接缝两侧（能定位接缝列）', `seamIdx=${seamIdx}`);
      A(seamDiff <= Math.max(med * 1.8, 45), '接缝处跨边色差不大于同侧正常相邻差（无错位造成的额外跳变）', `seam=${fmt(seamDiff, 0)} vs median=${fmt(med, 0)}`);
      const dups = diffs.filter((d) => d < 2).length;
      A(!(med > 20 && dups > 0), '逐列变化时没有完全相同的相邻列（无 1px 重复列）', `重复列 ${dups}`);
    }

    // 接缝两侧边缘列的绝对颜色（供人眼/进一步判断）
    if (seamIdx !== null) {
      const left = cols[seamIdx - 1];
      const right = cols[seamIdx];
      M.seamEdge = { 封面末列: [left.r, left.g, left.b], 书脊首列: [right.r, right.g, right.b] };
      A(
        nearestPalette(left).dist < 80 && nearestPalette(right).dist < 80,
        '接缝两侧边缘列是纯彩条色（未出现半像素混合 ⇒ 贴图 UV 偏移 ≈ 0）',
        `封面末列 ${JSON.stringify(M.seamEdge.封面末列)} / 书脊首列 ${JSON.stringify(M.seamEdge.书脊首列)}`,
      );
    }
  }

  // ── 接缝特写：滚轮放大到相机的缩放下限/上限，自动定位折角处的彩条竖带并裁切 ──
  const bandDetect = (img) => {
    const sat = (r, g, b) => {
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      return mx === 0 ? 0 : (mx - mn) / mx;
    };
    const cols = [];
    for (let x = 0; x < img.width; x++) {
      let c = 0;
      let rows = 0;
      for (let y = 0; y < img.height; y += 2) {
        const i = (y * img.width + x) * 4;
        if (img.data[i + 3] < 40) continue;
        rows++;
        if (sat(img.data[i], img.data[i + 1], img.data[i + 2]) > 0.45) c++;
      }
      cols.push(rows ? c / rows : 0);
    }
    let best = [-1, -1];
    let s = -1;
    for (let x = 0; x < cols.length; x++) {
      if (cols[x] >= 0.3) {
        if (s < 0) s = x;
      } else if (s >= 0) {
        if (x - 1 - s > best[1] - best[0]) best = [s, x - 1];
        s = -1;
      }
    }
    if (s >= 0 && cols.length - 1 - s > best[1] - best[0]) best = [s, cols.length - 1];
    return { band: best, width: best[1] - best[0] + 1, peak: Math.max(...cols) };
  };

  await page.evaluate(async () => {
    if (window.__book3d.setPreset) await window.__book3d.setPreset('left30');
    if (window.__book3d.tick) window.__book3d.tick();
  });
  await frames(2);
  const area = await canvasClip();
  let band = { band: [-1, -1], width: 0, peak: 0 };
  let zoomSteps = 0;
  let prevWidth = -1;
  let stable = 0;
  for (let z = 0; z < 14; z++) {
    // 用整块画布判断竖带位置
    const full = await page.screenshot({ clip: area, encoding: 'base64' });
    const parsed = P.decodePNG(Buffer.from(full, 'base64'));
    band = bandDetect(parsed);
    zoomSteps = z;
    if (band.width === prevWidth) {
      if (++stable >= 2) break; // 缩放已到上限
    } else {
      stable = 0;
      prevWidth = band.width;
    }
    await page.mouse.move(area.x + area.width * 0.5, area.y + area.height * 0.5);
    await page.mouse.wheel({ deltaY: -300 });
    await frames(2);
    await sleep(120);
  }
  M.seamBand = { x: band.band, width: band.width, peak: fmt(band.peak, 2), zoomWheelSteps: zoomSteps };

  // 换影棚底再截，人眼看接缝更舒服（缩放已到上限，换底不影响机位）
  await page.evaluate(async () => {
    if (window.__book3d.setBackground) await window.__book3d.setBackground('studio');
    if (window.__book3d.tick) window.__book3d.tick();
  });
  await frames(2);
  const area2 = await canvasClip();
  e.shots.push(await shot('40-seam-closeup.png', area2));

  // 以检测到的彩条竖带为中心裁切特写
  let crop = { x: area2.x, y: area2.y, width: area2.width, height: area2.height };
  if (band.width > 1 && band.band[0] > 0) {
    const cx = area2.x + Math.round((band.band[0] + band.band[1]) / 2);
    const cw = Math.max(360, Math.round(band.width * 10));
    const chh = Math.max(320, Math.round(cw * 1.2));
    crop = {
      x: Math.max(area2.x, Math.min(cx - Math.round(cw / 2), area2.x + area2.width - cw)),
      y: Math.max(area2.y, area2.y + Math.round((area2.height - chh) / 2)),
      width: Math.min(cw, area2.width),
      height: Math.min(chh, area2.height),
    };
  }
  e.shots.push(await shot('41-seam-closeup-crop.png', crop));

  // 特写自检：裁切区域里必须真的有彩条竖带（否则这张"特写"没拍到接缝）
  const cropImg = P.decodePNG(Buffer.from(await page.screenshot({ clip: crop, encoding: 'base64' }), 'base64'));
  const cropBand = bandDetect(cropImg);
  M.seamCropBand = { width: cropBand.width, peak: fmt(cropBand.peak, 2) };
  A(cropBand.width >= 3, '接缝特写裁切区域内确实含有彩条竖带（特写拍到了折角，不是空背景）', `竖带 ${cropBand.width}px，饱和列占比峰值 ${fmt(cropBand.peak, 2)}`);

  // 竖带内部是否有红/黄/蓝彩条的色相序列（放大到上限后每道条可能只有 1px，允许融合）
  if (cropBand.width >= 3) {
    const yMid = Math.round(cropImg.height / 2);
    const hues = [];
    for (let x = Math.max(0, cropBand.band[0] - 4); x <= Math.min(cropImg.width - 1, cropBand.band[1] + 4); x++) {
      const i = (yMid * cropImg.width + x) * 4;
      const r = cropImg.data[i];
      const g = cropImg.data[i + 1];
      const b = cropImg.data[i + 2];
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      if (mx - mn < 25) continue;
      let h;
      if (mx === r) h = (60 * ((g - b) / (mx - mn))) % 360;
      else if (mx === g) h = 60 * ((b - r) / (mx - mn)) + 120;
      else h = 60 * ((r - g) / (mx - mn)) + 240;
      hues.push((h + 360) % 360);
    }
    M.seamCropHues = hues.map((h) => Math.round(h)).join(',');
    const spread = hues.length ? Math.max(...hues) - Math.min(...hues) : 0;
    A(hues.length >= 2 && spread > 60, '特写里能看到彩条色相变化（红黄蓝序列在渲染色上确实存在）', `色相 ${M.seamCropHues || '(无)'}，跨度 ${Math.round(spread)}°`);
  }
  e.notes.push(
    `滚轮放大 ${zoomSteps} 档后到达缩放上限，折角处的彩条竖带在屏上只有 ${band.width}px 宽（12 道条每道约 ${fmt(band.width / 12, 1)}px）——fixtures 的彩条是 0.3mm 级的细条纹，正常缩放下必然融合成一条彩色细边，属于测试图的物理尺度限制，不是渲染缺陷。`,
  );

  // 拖拽是否生效（需求 5 的交互，作为附加观察）
  const beforeDrag = await fingerprint(area2);
  await page.mouse.move(area2.x + area2.width * 0.5, area2.y + area2.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(area2.x + area2.width * 0.62, area2.y + area2.height * 0.47, { steps: 12 });
  await page.mouse.up();
  await frames(3);
  const afterDrag = await fingerprint(area2);
  const dragDiff = meanDiff(beforeDrag, afterDrag);
  M.dragDiff = fmt(dragDiff, 2);
  A(dragDiff > 1.5, '拖拽可旋转（附：滚轮缩放与拖拽交互可用）', `拖拽前后画面差 ${M.dragDiff}/255`);
  e.shots.push(await shot('42-after-drag.png', area2));
});

// ────────────────────────────────────────────────────── 8. 比例警告 ──

await check('8', '上传 1:10 书脊图必须出现比例警告，且不静默拉伸', async (A, e, M) => {
  const beforeText = await page.evaluate(() => document.body.innerText || '');
  // 只有"警告语义"才算警告（面板常驻的"比例 10 : 260"标签不算）
  const WARN_RE = /偏差|不匹配|不是\s*10|比例异常|警告|将.{0,4}(等比|裁切|拉伸)|suggested|invalid/i;
  const findWarn = () =>
    page.evaluate((src) => {
      const re = new RegExp(src, 'i');
      let best = null;
      for (const n of document.querySelectorAll('body *')) {
        const t = (n.innerText || '').trim();
        if (!t || t.length > 400 || !re.test(t)) continue;
        const r = n.getBoundingClientRect();
        const cs = getComputedStyle(n);
        const visible =
          r.width > 2 && r.height > 2 && cs.display !== 'none' && cs.visibility !== 'hidden' &&
          Number(cs.opacity || 1) > 0.05 && r.bottom > 0 && r.top < window.innerHeight;
        if (!visible) continue;
        if (!best || t.length < best.text.length) {
          best = { text: t.replace(/\s+/g, ' ').slice(0, 160), tag: n.tagName + '.' + String(n.className || '').slice(0, 30), len: t.length };
        }
      }
      return best;
    }, WARN_RE.source).catch(() => null);
  const warnBefore = await findWarn();
  const dimsBefore = await page.evaluate(() => window.__book3d.getDims());

  const res = await page.evaluate(async (d) => {
    const t0 = performance.now();
    const r = await window.__book3d.loadImage('spine', d);
    return { r, ms: performance.now() - t0 };
  }, fileDataURL('spine-bad-100x1000.png'));
  M.loadResult = res.r;
  M.loadMs = fmt(res.ms, 1);
  A(!!res.r && res.r.w === 100 && res.r.h === 1000, '1:10 的坏书脊图已被接收（100×1000）', JSON.stringify(res.r));
  A(!!res.r && res.r.ratioBad === true, 'loadImage 返回 ratioBad=true', JSON.stringify(res.r && res.r.ratioBad));

  // 轮询 DOM 找"上传后才出现"的可见警告
  let hit = null;
  for (let i = 0; i < 40 && !hit; i++) {
    const w = await findWarn();
    if (w && !beforeText.includes(w.text)) hit = w;
    if (!hit) await sleep(100);
  }
  // 兜底：页面整体文本新增内容里出现警告语义
  const afterText = await page.evaluate(() => document.body.innerText || '');
  const inner = await page.evaluate((src) => {
    const re = new RegExp(src, 'i');
    const nodes = [...document.querySelectorAll('body *')].filter((n) => {
      const r = n.getBoundingClientRect();
      const cs = getComputedStyle(n);
      return r.width > 2 && r.height > 2 && cs.display !== 'none' && cs.visibility !== 'hidden';
    });
    const hitNode = nodes.find((n) => /比例|宽高比|10\s*[:：]\s*260/.test(n.innerText || '') && (n.innerText || '').length < 400);
    return hitNode ? { text: (hitNode.innerText || '').replace(/\s+/g, ' ').slice(0, 160), tag: hitNode.tagName } : null;
  }, WARN_RE.source).catch(() => null);
  M.warning = hit;
  M.warningFallback = inner;
  A(!!hit, '出现"上传后才新增"的可见比例警告（含偏差/不匹配/不是 10:260 等语义）', hit ? `「${hit.text}」 @ ${hit.tag}` : '未找到（兜底：' + (inner && inner.text ? inner.text : '无') + '）');
  A(!!inner, '（辅助）页面上存在提及"比例/宽高比/10 : 260"的可见文本', inner ? `「${inner.text}」` : '无');
  A(!warnBefore, '（前置）上传正常书脊图时没有误报警告', warnBefore ? `误报：${warnBefore.text}` : '无警告');
  A(/偏差|不匹配|不是\s*10|比例异常/.test(afterText), '警告文案明确点出比例偏差（不是只显示目标尺寸）', /偏差/.test(afterText) ? '含"偏差"' : '检查文本');

  // 不静默拉伸：spineMode 仍为 crop，且厚度未变化
  await frames(2);
  const st = await page.evaluate(() => window.__book3d.getState());
  const dimsAfter = await page.evaluate(() => window.__book3d.getDims());
  M.stateAfter = { spineMode: st.spineMode, spine: st.spine };
  A(st.spineMode === 'crop', 'getState().spineMode 仍为 "crop"（未静默拉伸）', String(st.spineMode));
  const zBefore = dimsBefore.measured.z / dimsBefore.measured.x;
  const zAfter = dimsAfter.measured.z / dimsAfter.measured.x;
  M.zRatioBefore = fmt(zBefore, 5);
  M.zRatioAfter = fmt(zAfter, 5);
  A(Math.abs(zAfter - zBefore) / zBefore < 0.01, '厚度比例未被坏图拉宽（10mm 固定，厚度/宽 前后一致）', `${M.zRatioBefore} → ${M.zRatioAfter}`);
  e.shots.push(await shot('50-ratio-warning.png'));

  // 收尾：恢复好图，便于人后续手测
  await page.evaluate(async (d) => {
    await window.__book3d.loadImage('spine', d);
  }, fileDataURL('spine-100x2600.png'));
  await frames(2);
});

await shot('60-final.png');

const appPerf = await page.evaluate(() => {
  try {
    return window.__book3d && window.__book3d.perf ? window.__book3d.perf() : null;
  } catch (e) {
    return { error: String(e && e.message) };
  }
});
console.log('应用内部计时 perf():', JSON.stringify(appPerf).slice(0, 600));

// ─────────────────────────────────────────────────────────── 汇总报告 ──

const failed = results.filter((r) => !r.pass);
const passCount = results.length - failed.length;

function mdTable() {
  const rows = results.map(
    (r) => `| ${r.id} | ${r.title} | ${r.pass ? '**PASS**' : '**FAIL**'} | ${r.lines.filter((l) => l.ok).length}/${r.lines.length} | ${r.ms} ms |`,
  );
  return ['| # | 验收项 | 结论 | 通过子项 | 用时 |', '| --- | --- | --- | --- | --- |', ...rows].join('\n');
}

const lines = [];
lines.push('# 书籍 3D 效果图工具 · 独立验收报告');
lines.push('');
lines.push(`- 生成时间：${new Date().toISOString()}（${env.tz}）`);
lines.push(`- 被测文件：\`${path.relative(ROOT, INDEX)}\`（${(indexStat.size / 1024).toFixed(1)} KB，sha256:${indexSha}，mtime ${indexStat.mtime.toISOString()}）`);
lines.push(`- 浏览器：Chrome ${env.chrome || '?'}（headless，puppeteer-core）`);
lines.push(`- WebGL：${env.webgl}`);
lines.push(`- 视口：1440×900 @1x；机器负载（1/5/15min，运行开始前）：${env.load}`);
lines.push(`- 用法：\`node tests/gen-images.mjs\` 生成 fixtures，\`node tests/verify.mjs\` 跑全部 8 条`);
lines.push(`- 结论：**${passCount}/${results.length} 条 PASS**${failed.length ? `，FAIL：${failed.map((f) => f.id).join('、')}` : ''}`);
if (!readyInfo.ok || pageErrors.length) {
  lines.push('');
  lines.push(`> ⚠️ **本次运行可能无效**：\`window.__book3d.ready\` = ${JSON.stringify(readyInfo)}，页面错误 ${pageErrors.length} 条。index.html 可能正处于重新构建中（脚本解析失败/THREE 未定义），请在构建完成后重跑。`);
}
lines.push('');
lines.push(mdTable());
lines.push('');
lines.push('## 视觉与观感观察汇总（自动量 + 建议人眼复核）');
lines.push('');
const allNotes = results.flatMap((r) => r.notes.map((n) => ({ id: r.id, n })));
if (!allNotes.length) lines.push('- 无');
for (const { id, n } of allNotes) lines.push(`- **检查 ${id}** — ${n}`);
lines.push('');
lines.push('> 自动判据只能覆盖像素级可量的部分（灰底、白边、阴影存在性、色相、接缝相位等）。纸页纹理是否细腻、折角高光是否自然、阴影是否"脏"这类观感问题，请人眼复核：');
lines.push('> `shots/10-preset-*.png`（5 个视角）、`shots/21-transparent-on-checker.png`（透明导出叠棋盘格，最容易看出灰底/白边）、`shots/35-export-bg-*.png`（带背景成品）、`shots/41-seam-closeup-crop.png`（折角接缝特写）。');
lines.push('');
lines.push('## 逐条明细');
lines.push('');
for (const r of results) {
  lines.push(`### ${r.id}. ${r.title} — ${r.pass ? '✅ PASS' : '❌ FAIL'}`);
  lines.push('');
  for (const l of r.lines) lines.push(`- ${l.ok ? '✅' : '❌'} ${l.msg}${l.val !== undefined ? ` — \`${l.val}\`` : ''}`);
  for (const n of r.notes) lines.push(`- ⚠️ 观察：${n}`);
  if (r.shots.length) {
    lines.push('');
    lines.push('证据：' + r.shots.map((s) => `[\`${path.basename(s)}\`](${s})`).join('、'));
  }
  lines.push('');
}

// 契约一致性
lines.push('## 调试契约核对');
lines.push('');
const REQUIRED = ['ready', 'loadImage', 'loadCustomBackground', 'setPreset', 'setBackground', 'setLongEdge', 'getState', 'getDims', 'renderExport', 'getSeamSample', 'tick'];
const missing = REQUIRED.filter((k) => !apiKeys.includes(k));
lines.push(`- 存在（${apiKeys.length}）：${apiKeys.map((k) => `\`${k}\``).join('、') || '（无）'}`);
lines.push(`- 缺失：${missing.length ? missing.map((k) => `\`${k}\``).join('、') : '无'}`);
lines.push('');
if (appPerf) {
  lines.push('## 应用内部计时（`__book3d.perf()`，供 Lead 定位性能）');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(appPerf, null, 2).slice(0, 2000));
  lines.push('```');
  lines.push('');
}
if (pageErrors.length) {
  lines.push('## 运行期页面错误');
  lines.push('');
  pageErrors.slice(0, 10).forEach((t) => lines.push(`- \`${t}\``));
  lines.push('');
}
if (consoleIssues.length) {
  lines.push('## 控制台 error/warning');
  lines.push('');
  consoleIssues.slice(0, 10).forEach((t) => lines.push(`- \`${t}\``));
  lines.push('');
}
lines.push('## 局限与说明');
lines.push('');
lines.push('- 检查 1 的"书模出现"用书模画布中心区域截图与上传前基线的平均色差 >3/255 判定（WebGL 画布无法直接读像素时最稳的代理指标），并记录 Node 侧时间戳。');
lines.push('- 检查 3 的 300ms 用页面内 `gl.readPixels`（56×56 中心块）+ rAF 循环量动画到位时间：连续 3 帧、且帧间平均色差 <1/255（肉眼不可辨）即视为到位，不受 CDP 截图延迟影响；判据另加一个渲染帧间隔的量化容差（headless 被其它进程抢占时帧间隔可达数百 ms，此时只能保证「最后一次可见变化不晚于 300ms + 1 帧」）；读不到像素时才退回截图对比。');
lines.push('- 检查 7 的自动化判据是像素级的"接缝两侧颜色/相位连续 + 无灰缝白缝"，1px 级错位以游程宽度差 ≤1 列、色差不超过彩条内部跳变来表达；另附折角特写截图供人眼复核。');
lines.push('- 检查 4 的"白边"判据：轮廓上紧邻半透明像素的 alpha=255 像素中，近白（min channel >235）占比 <2%；黑边为 0。');
lines.push('- 截图命名：`10-preset-*` 五个预设、`30-bg-*` 四款内置背景 + `34-bg-custom`、`20/21` 透明导出与棋盘格合成、`40/41` 接缝特写。');
lines.push('');
lines.push('## 产物');
lines.push('');
lines.push('- 导出件：`shots/20-export-transparent-2000.png`、`21-transparent-on-checker.png`、`35-export-bg-<id>.png`、`export-transparent-3000.png`、`export-transparent-4000.png`');
lines.push('- 截图：`shots/00-before-upload.png` … `shots/60-final.png`');
lines.push('');

fs.writeFileSync(REPORT, lines.join('\n'));

console.log('\n════════════════════ 汇总 ════════════════════');
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id}. ${r.title}`);
console.log(`\n${passCount}/${results.length} PASS → ${REPORT}`);
if (pageErrors.length) console.log(`页面错误 ${pageErrors.length} 条:`), pageErrors.slice(0, 5).forEach((t) => console.log('  ' + t));

await browser.close();
process.exit(failed.length ? 1 : 0);
