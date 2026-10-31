#!/usr/bin/env node
/**
 * gifshot.js — 把带 CSS 动画的 HTML 截成 GIF（愿望⑫的落地工具）。
 * 零依赖：CDP 逐帧冻结动画截图 + zlib 解 PNG + 手写 LZW 编 GIF89a。
 *
 * 用法:
 *   node gifshot.js <input.html> -o out.gif [--frames 24] [--duration 3000]
 *                   [--width 512] [--scale 1] [--selector css] [--font] [--loop 0]
 * 也作库用: const { gifshot } = require('./gifshot')
 *
 * 契约：页面里要有 CSS animation（getAnimations 能拿到的）；--duration 秒数
 * 最好取各动画时长的公倍数，不然循环处会跳一下。动画按 currentTime 整体冻结
 * 到时间点 t 再截，所以 every frame 都是确定性的，不靠录屏。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pathToFileURL } = require('url');
const { launchBrowser, FONT_CSS } = require('./webshot');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function evalJson(c, expression) {
  const r = await c.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('页面脚本执行失败: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text));
  return r.result.value;
}

// ---------- PNG 解码（复用 webshot.pngChromaKey 的反滤波思路，只还原图像不要 alpha）----------
function pngToRGB(png) {
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  const bitDepth = png[24], colorType = png[25];
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`gifshot 只支持 8 位 RGB/RGBA PNG（depth=${bitDepth} colorType=${colorType}）`);
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
  const rgb = Buffer.alloc(w * h * 3);
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  // 滤波按字节行进；RGB 三通道一起反解，边解边落 rgb 缓冲
  const line = Buffer.alloc(stride);
  const prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    raw.copy(line, 0, y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? line[x - bpp] : 0;
      const up = prev[x];
      const ul = x >= bpp ? prev[x - bpp] : 0;
      let v;
      if (f === 0) v = line[x];
      else if (f === 1) v = line[x] + left;
      else if (f === 2) v = line[x] + up;
      else if (f === 3) v = line[x] + ((left + up) >> 1);
      else v = line[x] + paeth(left, up, ul);
      line[x] = v & 0xff;
    }
    for (let x = 0; x < w; x++) {
      rgb[(y * w + x) * 3] = line[x * bpp];
      rgb[(y * w + x) * 3 + 1] = line[x * bpp + 1];
      rgb[(y * w + x) * 3 + 2] = line[x * bpp + 2];
    }
    line.copy(prev);
  }
  return { w, h, rgb };
}

// ---------- 调色板：直方图 + 中位切分，压到 maxColors 色 ----------
function buildPalette(pixels, maxColors) {
  const hist = new Map(); // 颜色 → 像素数（抽样统计）
  for (let i = 0; i < pixels.length; i += 3 * 5) {
    const key = (pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2];
    hist.set(key, (hist.get(key) || 0) + 1);
  }
  const keys = [...hist.keys()];
  if (keys.length <= maxColors) return keys;

  // 中位切分：每次挑「像素量 × 长边范围」最大的盒子，沿最长的通道从中位数劈开
  const mkBox = (colors) => {
    let lo = [255, 255, 255], hi = [0, 0, 0], count = 0;
    for (const k of colors) {
      const n = hist.get(k), r = (k >> 16) & 255, g = (k >> 8) & 255, b = k & 255;
      count += n;
      for (let c = 0; c < 3; c++) { const v = [r, g, b][c]; if (v < lo[c]) lo[c] = v; if (v > hi[c]) hi[c] = v; }
    }
    return { colors, lo, hi, count };
  };
  const boxes = [mkBox(keys)];
  while (boxes.length < maxColors) {
    // 只切还有 ≥2 色的盒子；全是单色盒就提前收工
    const splittable = boxes.filter((b) => b.colors.length >= 2);
    if (splittable.length === 0) break;
    let bi = -1, score = -1;
    splittable.forEach((b, i) => {
      const range = Math.max(b.hi[0] - b.lo[0], b.hi[1] - b.lo[1], b.hi[2] - b.lo[2]);
      const s = b.count * (range + 1);
      if (s > score) { score = s; bi = i; }
    });
    const box = boxes[bi];
    const axis = [0, 1, 2].map((c) => [c, box.hi[c] - box.lo[c]]).sort((a, b) => b[1] - a[1])[0][0];
    const shift = [16, 8, 0][axis];
    box.colors.sort((a, b) => ((a >> shift) & 255) - ((b >> shift) & 255));
    // 按像素量找中位切点，别按颜色数——颜色稀有但像素多的一侧该留在原地
    let acc = 0;
    let mid = 0;
    for (let i = 0; i < box.colors.length; i++) {
      acc += hist.get(box.colors[i]);
      if (acc >= box.count / 2) { mid = i + 1; break; }
    }
    if (mid <= 0 || mid >= box.colors.length) mid = box.colors.length >> 1;
    boxes[bi] = mkBox(box.colors.slice(0, mid));
    boxes.push(mkBox(box.colors.slice(mid)));
  }
  // 盒子平均色当调色板
  return boxes.map((b) => {
    let r = 0, g = 0, bl = 0, n = 0;
    for (const k of b.colors) { const c = hist.get(k); r += ((k >> 16) & 255) * c; g += ((k >> 8) & 255) * c; bl += (k & 255) * c; n += c; }
    return (Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(bl / n);
  });
}

// 像素 → 调色板索引。直方图里出现过的颜色先查缓存；漏网的再算最近邻（扁平插画里很少发生）
function quantize(pixels, palette) {
  const palRGB = palette.map((k) => [(k >> 16) & 255, (k >> 8) & 255, k & 255]);
  const cache = new Map(); // 颜色 key → 索引（调色板本体先落位）
  palette.forEach((k, i) => cache.set(k, i));
  const nearest = (r, g, b) => {
    let best = 0, bd = Infinity;
    for (let i = 0; i < palRGB.length; i++) {
      const dr = r - palRGB[i][0], dg = g - palRGB[i][1], db = b - palRGB[i][2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };
  const idx = Buffer.alloc(pixels.length / 3);
  for (let i = 0; i < idx.length; i++) {
    const r = pixels[i * 3], g = pixels[i * 3 + 1], b = pixels[i * 3 + 2];
    const key = (r << 16) | (g << 8) | b;
    let v = cache.get(key);
    if (v === undefined) { v = nearest(r, g, b); cache.set(key, v); }
    idx[i] = v;
  }
  return idx;
}

// ---------- GIF LZW 压缩（omggif 同款节奏：先发码，再查表越界时升位）----------
class BitWriter {
  constructor() { this.bytes = []; this.cur = 0; this.n = 0; }
  write(code, size) {
    for (let i = 0; i < size; i++) {
      this.cur |= ((code >> i) & 1) << this.n;
      if (++this.n === 8) { this.bytes.push(this.cur); this.cur = 0; this.n = 0; }
    }
  }
  flush() { if (this.n > 0) { this.bytes.push(this.cur); this.cur = 0; this.n = 0; } return Buffer.from(this.bytes); }
}

function lzwEncode(indices, minCodeSize) {
  const clear = 1 << minCodeSize, eoi = clear + 1;
  let codeSize = minCodeSize + 1, next = eoi + 1;
  const bw = new BitWriter();
  bw.write(clear, codeSize);
  let dict = new Map();
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const code = dict.get(key);
    if (code !== undefined) { prefix = code; continue; }
    bw.write(prefix, codeSize);
    if (next === 4096) { // 表满：发 clear 重置（deferred clear 都不做了，简单优先）
      bw.write(clear, codeSize);
      dict = new Map(); next = eoi + 1; codeSize = minCodeSize + 1;
    } else {
      if (next >= (1 << codeSize) && codeSize < 12) codeSize++;
      dict.set(key, next++);
    }
    prefix = k;
  }
  bw.write(prefix, codeSize);
  bw.write(eoi, codeSize);
  return bw.flush();
}

function subBlocks(data) {
  const out = [];
  for (let i = 0; i < data.length; i += 255) {
    const chunk = data.subarray(i, Math.min(i + 255, data.length));
    out.push(Buffer.from([chunk.length]), chunk);
  }
  out.push(Buffer.from([0]));
  return Buffer.concat(out);
}

// ---------- GIF89a 组装 ----------
function encodeGif(frames /* [{w,h,indices}] */, palette, delayCs, loop) {
  const bits = Math.max(2, Math.ceil(Math.log2(Math.max(2, palette.length))));
  const tableSize = 1 << bits;
  const head = Buffer.concat([
    Buffer.from('GIF89a', 'ascii'),
    Buffer.from([frames[0].w & 255, frames[0].w >> 8, frames[0].h & 255, frames[0].h >> 8]),
    Buffer.from([0x80 | ((bits - 1) & 7), 0, 0]), // GCT 有，色深 bits，无排序
  ]);
  const gct = Buffer.alloc(tableSize * 3);
  palette.forEach((k, i) => { gct[i * 3] = (k >> 16) & 255; gct[i * 3 + 1] = (k >> 8) & 255; gct[i * 3 + 2] = k & 255; });
  const loopExt = Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0', 'ascii'), 3, 1, loop & 255, (loop >> 8) & 255, 0]);
  const gce = Buffer.from([0x21, 0xf9, 4, 0x04, delayCs & 255, (delayCs >> 8) & 255, 0, 0]); // disposal=1，无透明
  const body = frames.map((f) => Buffer.concat([
    gce,
    Buffer.from([0x2c, 0, 0, 0, 0, f.w & 255, f.w >> 8, f.h & 255, f.h >> 8, 0]),
    Buffer.from([Math.max(2, bits)]), // LZW 最小码长
    subBlocks(lzwEncode(f.indices, Math.max(2, bits))),
  ]));
  return Buffer.concat([head, gct, loopExt, ...body, Buffer.from([0x3b])]);
}

// ---------- 主流程 ----------
/**
 * 在已启动的浏览器上把一个 CSS 动画页面截成 GIF。
 * opts: { url, out, width=512, scale=1, frames=24, duration=3000, selector=null, fontCss=null, loop=0, extraWait=0 }
 */
async function gifshot(browser, opts) {
  const { url, out } = opts;
  const width = opts.width || 512;
  const scale = opts.scale || 1;
  const frames = Math.max(2, Number(opts.frames) || 24);
  const duration = Math.max(100, Number(opts.duration) || 3000);

  const target = await (await fetch(`http://127.0.0.1:${browser.port}/json/new?about:blank`, { method: 'PUT' })).json();
  if (typeof WebSocket !== 'function') throw new Error('本 Node 没有 WebSocket 全局（需 ≥22），零依赖路线走不通');
  const conn = await new Promise((resolve, reject) => {
    let id = 0; const pending = new Map(); let handlers = [];
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) { const { resolve: rs, reject: rj } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rj(new Error(msg.error.message)) : rs(msg.result); }
      else handlers.forEach((h) => h(msg));
    };
    ws.onopen = () => resolve({
      send: (method, params = {}) => new Promise((rs, rj) => { const mid = ++id; pending.set(mid, { resolve: rs, reject: rj }); ws.send(JSON.stringify({ id: mid, method, params })); }),
      on: (h) => handlers.push(h),
      close: () => { handlers = []; ws.close(); },
    });
    ws.onerror = reject;
  });

  try {
    await conn.send('Page.enable');
    await conn.send('Runtime.enable');
    if (opts.fontCss) await conn.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const s=document.createElement('style');s.textContent=${JSON.stringify(opts.fontCss)};document.addEventListener('DOMContentLoaded',()=>document.head.appendChild(s));})();` });
    await conn.send('Emulation.setDeviceMetricsOverride', { width, height: width, deviceScaleFactor: scale, mobile: false });
    await conn.send('Page.navigate', { url });
    const deadline = Date.now() + 30000;
    for (;;) {
      await sleep(150);
      const state = await evalJson(conn, 'document.readyState');
      if (state === 'complete') break;
      if (Date.now() > deadline) throw new Error('页面 30s 没加载完: ' + url);
    }
    await evalJson(conn, 'document.fonts ? document.fonts.ready.then(() => true) : true');
    if (opts.extraWait) await sleep(opts.extraWait);

    const nAnim = await evalJson(conn, 'document.getAnimations({subtree:true}).length');
    if (nAnim === 0) throw new Error('页面上没有 CSS 动画（getAnimations 返回 0），gifshot 只管动画页');

    // 裁剪框：选择器联合包围盒，或整页
    let clip;
    if (opts.selector) {
      clip = await evalJson(conn, `(() => {
        const els = [...document.querySelectorAll(${JSON.stringify(opts.selector)})];
        if (els.length === 0) throw new Error('选择器没匹配到元素: ' + ${JSON.stringify(opts.selector)});
        let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
        for (const el of els) {
          const r = el.getBoundingClientRect();
          x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y + window.scrollY);
          x2 = Math.max(x2, r.x + r.width); y2 = Math.max(y2, r.y + r.height + window.scrollY);
        }
        return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
      })()`);
    } else {
      clip = await evalJson(conn, `({ x: 0, y: 0, width: Math.ceil(document.documentElement.scrollWidth), height: Math.ceil(document.documentElement.scrollHeight) })`);
    }
    clip = { x: 0, y: Math.max(0, Math.round(clip.y)), width: Math.ceil(clip.width), height: Math.ceil(clip.height), scale: 1 };

    // 逐帧：所有动画整体冻结到 t 再截——确定性输出，重跑同参必得同图
    const pngs = [];
    for (let i = 0; i < frames; i++) {
      const t = Math.round((i * duration) / frames);
      await evalJson(conn, `document.getAnimations({subtree:true}).forEach(a => { a.pause(); a.currentTime = ${t}; });`);
      const shot = await conn.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
      pngs.push(Buffer.from(shot.data, 'base64'));
    }

    // 解码全部帧 → 统一调色板 → 索引化 → 编 GIF
    const decoded = pngs.map(pngToRGB);
    const w = decoded[0].w, h = decoded[0].h;
    if (decoded.some((d) => d.w !== w || d.h !== h)) throw new Error('各帧尺寸不一致，动画里别改布局尺寸');
    const allPixels = Buffer.concat(decoded.map((d) => d.rgb));
    const palette = buildPalette(allPixels, 256); // GIF 全局色表上限 256 色
    const gifFrames = decoded.map((d) => ({ w, h, indices: quantize(d.rgb, palette) }));
    const delayCs = Math.max(2, Math.round(duration / frames / 10));
    const loop = opts.loop === undefined ? 0 : Number(opts.loop);
    fs.writeFileSync(out, encodeGif(gifFrames, palette, delayCs, loop));
    return { out, width: w, height: h, frames, palette: palette.length, delayCs };
  } finally {
    conn.close();
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
  const flagsWithValues = new Set(['-o', '--width', '--scale', '--frames', '--duration', '--selector', '--wait', '--loop']);
  let input = null;
  for (let i = 0; i < argv.length; i++) {
    if (flagsWithValues.has(argv[i])) { i++; continue; }
    if (argv[i].startsWith('-')) continue;
    if (!input) input = argv[i];
  }
  const out = get('-o', null);
  if (!input || !out) {
    console.error('用法: node gifshot.js <input.html> -o out.gif [--frames 24] [--duration 3000] [--width 512] [--scale 1] [--selector css] [--font] [--loop 0]');
    process.exit(2);
  }
  const isUrl = /^https?:\/\//i.test(input);
  const url = isUrl ? input : pathToFileURL(path.resolve(input)).href;

  const browser = await launchBrowser();
  try {
    const r = await gifshot(browser, {
      url, out,
      width: Number(get('--width', 512)),
      scale: Number(get('--scale', 1)),
      frames: Number(get('--frames', 24)),
      duration: Number(get('--duration', 3000)),
      selector: get('--selector', null),
      extraWait: Number(get('--wait', 0)),
      loop: get('--loop', 0),
      fontCss: argv.includes('--font') ? FONT_CSS : null,
    });
    console.log(`OK ${r.out} (${r.width}x${r.height}, ${r.frames} 帧, ${r.palette} 色, ${r.delayCs}cs/帧)`);
  } finally {
    browser.close();
  }
}

if (require.main === module) main().catch((e) => { console.error('FAIL ' + e.message); process.exit(1); });
module.exports = { gifshot, pngToRGB, buildPalette, quantize, lzwEncode, encodeGif };
