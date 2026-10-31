#!/usr/bin/env node
'use strict';
/**
 * webshot.js — 无头浏览器截图工具（零依赖，用 Chrome/Edge 自带 CDP）
 *
 * 用法:
 *   node webshot.js <input.html | https://url> -o out.png [选项]
 *
 * 选项:
 *   -o <path>       输出 PNG 路径（必填）
 *   --width <n>     视口宽度，默认 900
 *   --scale <n>     deviceScaleFactor，默认 1；2 = 2 倍清晰度
 *   --font          强制注入「LXGW WenKai GB」字体
 *   --selector <css> 只截取元素（按元素尺寸裁剪）；逗号分隔多个选择器时截联合包围盒
 *   --transparent   背景透明输出（PNG RGBA），配图标/贴纸素材用
 *   --networkidle   等网络连续 600ms 无在途请求再截（动态页面用；上限 10s）
 *   --wait <ms>     截图前额外等待，默认 0（字体加载已自动等待）
 *
 * 也作为库使用: module.exports = { launchBrowser, shoot }
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const FONT_CSS = "body{font-family:'LXGW WenKai GB' !important;}";
// 透明模式的抠图键色。约定：要透明的页面里不许出现纯洋红。
const CHROMA_BG_CSS = "html,body{background:#ff00ff !important;}";

const BROWSER_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  // Linux/macOS（CI 与非 Windows 用户）：无斜杠的裸名靠 POSIX spawn 走 PATH
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'google-chrome',
  'chromium',
];

function findBrowser() {
  const hit = BROWSER_CANDIDATES.find((p) => fs.existsSync(p));
  if (!hit) throw new Error('没找到 Chrome/Edge，检查 ' + BROWSER_CANDIDATES.join(' , '));
  return hit;
}

/** 启动无头浏览器，返回 { port, close() }。port 由 Chrome 自动分配。 */
async function launchBrowser() {
  const exe = findBrowser();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webshot-profile-'));
  const proc = spawn(exe, [
    '--headless=new',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profileDir,
    '--no-first-run',
    '--disable-extensions',
    '--hide-scrollbars',
    '--disable-gpu',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('浏览器 15s 内没报出调试端口')), 15000);
    const onData = (d) => {
      buf += d.toString();
      const m = buf.match(/DevTools listening on (ws:\/\/[^"\s]+)/);
      if (m) {
        clearTimeout(timer);
        const wsUrl = m[1]; // ws://127.0.0.1:<port>/devtools/browser/<id>
        resolve(Number(new URL(wsUrl).port));
      }
    };
    proc.stderr.on('data', onData);
    proc.stdout.on('data', onData);
    proc.on('exit', () => reject(new Error('浏览器启动后立刻退出，stderr: ' + buf.slice(0, 500))));
  });

  return {
    port,
    close() {
      // Windows 下直接 kill 杀不干净子进程，用 taskkill 连树一起拔；POSIX 直接 SIGKILL
      if (process.platform === 'win32') {
        if (proc.pid) spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        try { proc.kill('SIGKILL'); } catch (_) { /* 已退出就算了 */ }
      }
      try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (_) { /* 临时目录，删不掉就算了 */ }
    },
  };
}

/** 极简 CDP 客户端：send() 发命令，on() 收事件 */
function cdp(wsUrl) {
  let seq = 0;
  const pending = new Map();
  const listeners = [];
  const ws = new WebSocket(wsUrl);
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else {
      listeners.forEach((f) => f(msg));
    }
  });
  return {
    ready: new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', () => rej(new Error('WebSocket 连接浏览器失败')));
    }),
    send(method, params = {}) {
      return new Promise((res, rej) => {
        const id = ++seq;
        pending.set(id, (m) => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result)));
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    on(fn) {
      listeners.push(fn);
      return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
    },
    close() { try { ws.close(); } catch (_) { /* 忽略 */ } },
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * pngChromaKey — 把纯洋红（#ff00ff）底抠成透明，输出 RGBA PNG。
 * 新版无头 Chrome 的背景覆盖不生效、截图永远不透明，只能在像素层解决。
 * 反走样边缘按「P = a·C + (1-a)·K」反解出真色 C 和透明度 a，不留洋红边。
 * 依赖 Node 内置 zlib（inflate/deflate/crc32），仍是零依赖。
 */
const zlib = require('zlib');

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crcBuf]);
}

function pngChromaKey(png) {
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  const bitDepth = png[24], colorType = png[25];
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`透明模式只支持 8 位 RGB/RGBA PNG（depth=${bitDepth} colorType=${colorType}）`);
  }
  const bpp = colorType === 6 ? 4 : 3;

  let off = 8;
  const idat = [];
  while (off + 12 <= png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(png.subarray(off + 8, off + 8 + len));
    off += 12 + len;
    if (type === 'IEND') break;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;

  // 反滤波（PNG filter 0-4）还原原始像素
  const px = Buffer.alloc(h * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const r = raw[y * (stride + 1) + 1 + x];
      const left = x >= bpp ? px[y * stride + x - bpp] : 0;
      const up = y > 0 ? px[(y - 1) * stride + x] : 0;
      const ul = y > 0 && x >= bpp ? px[(y - 1) * stride + x - bpp] : 0;
      let v;
      if (f === 0) v = r;
      else if (f === 1) v = r + left;
      else if (f === 2) v = r + up;
      else if (f === 3) v = r + ((left + up) >> 1);
      else v = r + paeth(left, up, ul);
      px[y * stride + x] = v & 0xff;
    }
  }

  // 抠键：a = clamp(到键色的曼哈顿距离 / 255, 0, 1)。
  // 白色内容与键色的混合像素距离恰好 = 255·真实alpha，边缘反解最准；
  // 大多数实色（距离 ≥ 255）自动落回完全不透明。亮粉紫系内容会被误判，透明页面里别用。
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const r = px[i * bpp], g = px[i * bpp + 1], b = px[i * bpp + 2];
    const d = (255 - r) + g + (255 - b);
    const a = Math.max(0, Math.min(1, d / 255));
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = colorType === 6 ? px[i * bpp + 3] : Math.round(a * 255);
    if (a > 0 && a < 1) { // 边缘半透明像素按 P = a·C + (1-a)·K 反解真色，去掉洋红晕
      const t = (1 - a) * 255;
      rgba[i * 4] = Math.max(0, Math.min(255, Math.round((r - t) / a)));
      rgba[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(g / a)));
      rgba[i * 4 + 2] = Math.max(0, Math.min(255, Math.round((b - t) / a)));
    }
  }

  // 重新编码：每行 filter 0
  const raw2 = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw2[y * (w * 4 + 1)] = 0;
    rgba.copy(raw2, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw2, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function evalJson(c, expression) {
  const r = await c.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error('页面脚本执行失败: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text));
  return r.result.value;
}

/**
 * 在已启动的浏览器上截一张图。
 * opts: { url, out, width=900, scale=1, fontCss=null, selector=null, extraWait=0, transparent=false }
 */
async function shoot(browser, opts) {
  const { url, out } = opts;
  const width = opts.width || 900;
  const scale = opts.scale || 1;
  const selector = opts.selector || null;

  const target = await (await fetch(`http://127.0.0.1:${browser.port}/json/new?about:blank`, { method: 'PUT' })).json();
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  try {
    await c.send('Page.enable');
    await c.send('Runtime.enable');
    if (opts.fontCss) await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const s=document.createElement('style');s.textContent=${JSON.stringify(opts.fontCss)};document.addEventListener('DOMContentLoaded',()=>document.head.appendChild(s));})();` });
    if (opts.transparent) await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const s=document.createElement('style');s.textContent=${JSON.stringify(CHROMA_BG_CSS)};document.addEventListener('DOMContentLoaded',()=>document.head.appendChild(s));})();` });
    // 智能等待要在导航前挂上网络监听，不然首屏请求会漏计
    let inflight = null;
    if (opts.networkIdle) {
      inflight = 0;
      c.on((msg) => {
        if (msg.method === 'Network.requestWillBeSent') inflight++;
        else if (msg.method === 'Network.loadingFinished' || msg.method === 'Network.loadingFailed') inflight--;
      });
      await c.send('Network.enable');
    }
    await c.send('Page.navigate', { url });
    await c.send('Emulation.setDeviceMetricsOverride', {
      width, height: 800, deviceScaleFactor: scale, mobile: false,
    });
    await c.send('Page.navigate', { url });

    // 等页面加载完（轮询 readyState，比监听 loadEventFired 抗噪）
    const deadline = Date.now() + 30000;
    for (;;) {
      await sleep(150);
      const state = await evalJson(c, 'document.readyState');
      if (state === 'complete') break;
      if (Date.now() > deadline) throw new Error('页面 30s 没加载完: ' + url);
    }
    await evalJson(c, 'document.fonts ? document.fonts.ready.then(() => true) : true');
    if (inflight !== null) {
      // 网络连续 600ms 无在途请求才算空闲；10s 等不到就带病截（长轮询页面不该卡死截图）
      const deadline = Date.now() + 10000;
      let quiet = 0;
      for (;;) {
        await sleep(100);
        if (inflight <= 0) { quiet += 100; if (quiet >= 600) break; }
        else quiet = 0;
        if (Date.now() > deadline) break;
      }
    }
    if (opts.extraWait) await sleep(opts.extraWait);

    // 算裁剪区域：整页 or 指定元素（逗号分隔多个选择器 → 联合包围盒）
    let clip;
    if (selector) {
      clip = await evalJson(c, `(() => {
        const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
        if (els.length === 0) throw new Error('选择器没匹配到元素: ' + ${JSON.stringify(selector)});
        let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
        for (const el of els) {
          const r = el.getBoundingClientRect();
          x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y + window.scrollY);
          x2 = Math.max(x2, r.x + r.width); y2 = Math.max(y2, r.y + r.height + window.scrollY);
        }
        return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
      })()`);
    } else {
      clip = await evalJson(c, `({ x: 0, y: 0, width: Math.ceil(document.documentElement.scrollWidth), height: Math.ceil(document.documentElement.scrollHeight) })`);
    }
    clip = { x: 0, y: Math.max(0, clip.y), width: Math.ceil(clip.width), height: Math.ceil(clip.height), scale: 1 };

    const shot = await c.send('Page.captureScreenshot', {
      format: 'png', clip, captureBeyondViewport: true,
    });
    const buf = Buffer.from(shot.data, 'base64');
    fs.writeFileSync(out, opts.transparent ? pngChromaKey(buf) : buf);
    return { out, width: clip.width, height: clip.height };
  } finally {
    c.close();
    await fetch(`http://127.0.0.1:${browser.port}/json/close/${target.id}`).catch(() => {});
  }
}

// ---------- CLI ----------
async function main() {
  const argv = process.argv.slice(2);
  const get = (flag, def) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
  };
  const flagsWithValues = new Set(['-o', '--width', '--scale', '--selector', '--wait']);
  let input = null;
  for (let i = 0; i < argv.length; i++) {
    if (flagsWithValues.has(argv[i])) { i++; continue; } // 跳过旗标和它的值
    if (argv[i].startsWith('-')) continue;
    if (!input) input = argv[i];
  }
  const out = get('-o', null);
  if (!input || !out) {
    console.error('用法: node webshot.js <input.html|url> -o out.png [--width 900] [--scale 2] [--font] [--selector css] [--transparent] [--networkidle] [--wait ms]');
    process.exit(2);
  }
  const isUrl = /^https?:\/\//i.test(input);
  const url = isUrl ? input : pathToFileURL(path.resolve(input)).href;

  const browser = await launchBrowser();
  try {
    const r = await shoot(browser, {
      url, out,
      width: Number(get('--width', 900)),
      scale: Number(get('--scale', 1)),
      fontCss: argv.includes('--font') ? FONT_CSS : null,
      selector: get('--selector', null),
      extraWait: Number(get('--wait', 0)),
      transparent: argv.includes('--transparent'),
      networkIdle: argv.includes('--networkidle'),
    });
    console.log(`OK ${r.out} (${r.width}x${r.height})`);
  } finally {
    browser.close();
  }
}

if (require.main === module) main().catch((e) => { console.error('FAIL ' + e.message); process.exit(1); });

module.exports = { launchBrowser, shoot, FONT_CSS };
