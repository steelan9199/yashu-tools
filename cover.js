#!/usr/bin/env node
'use strict';
/**
 * cover.js — 公众号封面图生成（900×383，微信标准 2.35:1，scale 2 输出 1800×766）
 *
 * 两种风格:
 *   dark  深蓝夜空 + 大圆月（贴合本工作室剪纸 MV 的视觉母题）
 *   paper 米白纸面 + 手账风下划线
 *
 * 用法:
 *   node cover.js --title "标题" [--subtitle "副标题"] [--style dark|paper]
 *                 [--accent "#色值"] [-o out.png] [--scale 2]
 *
 * 字体铁律内建：只用 'LXGW WenKai GB'，字重 300/400/500。
 * 退出码: 0 = 成功；1 = 失败；2 = 参数错误
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { shoot, launchBrowser } = require('./webshot');

function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

const STYLES = {
  dark: (a) => `background:linear-gradient(160deg,#0e1a33 0%,#15264d 55%,#1d3262 100%);color:#f5f0e6;`,
  paper: (a) => `background:#f7f3ea;color:#2b2b2b;`,
};

function coverHtml({ title, subtitle, style, accent }) {
  const isDark = style === 'dark';
  const bg = isDark
    ? 'linear-gradient(160deg,#0e1a33 0%,#15264d 55%,#1d3262 100%)'
    : '#f7f3ea';
  const fg = isDark ? '#f5f0e6' : '#2b2b2b';
  const moon = isDark
    ? `<div style="position:absolute;right:70px;top:56px;width:130px;height:130px;border-radius:50%;
         background:#f2e9d8;box-shadow:0 0 0 18px rgba(242,233,216,.08),0 0 0 36px rgba(242,233,216,.04);"></div>
       <div style="position:absolute;right:0;bottom:0;left:0;height:74px;
         background:linear-gradient(180deg,transparent 0%,rgba(10,20,40,.35) 100%);"></div>`
    : `<div style="position:absolute;right:64px;top:64px;width:110px;height:110px;border-radius:50%;
         border:3px solid ${accent};opacity:.35;"></div>`;
  const sub = subtitle
    ? `<div style="margin-top:22px;font-size:26px;font-weight:300;letter-spacing:2px;opacity:.82;">${esc(subtitle)}</div>`
    : '';
  return `<!doctype html><meta charset="utf-8">
<style>
  body { margin:0; font-family:'LXGW WenKai GB'; }
  #cover { position:relative; width:900px; height:383px; overflow:hidden; background:${bg}; color:${fg}; }
  .wrap { position:absolute; left:64px; top:50%; transform:translateY(-50%); max-width:600px; }
  .tag { display:inline-block; font-size:18px; font-weight:400; letter-spacing:6px;
         color:${accent}; border:1px solid ${accent}; padding:3px 14px 3px 20px; border-radius:3px; }
  h1 { margin:0; font-size:58px; line-height:1.28; font-weight:500; letter-spacing:2px; }
  .bar { margin-top:26px; width:96px; height:5px; background:${accent}; border-radius:2px; }
</style>
<div id="cover">
  ${moon}
  <div class="wrap">
    <div class="tag">${isDark ? 'AI 手记' : 'AI 手记'}</div>
    <h1 style="margin-top:24px;">${esc(title)}</h1>
    ${sub}
    <div class="bar"></div>
  </div>
</div>`;
}

async function main() {
  const argv = process.argv.slice(2);
  const get = (flag, def) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
  };
  const title = get('--title', null);
  if (!title) {
    console.error('用法: node cover.js --title "标题" [--subtitle "副标题"] [--style dark|paper] [--accent "#色值"] [-o out.png] [--scale 2]');
    process.exit(2);
  }
  const style = get('--style', 'dark');
  if (!STYLES[style]) { console.error(`FAIL 不认识的风格: ${style}（可选 dark / paper）`); process.exit(2); }
  const accent = get('--accent', style === 'dark' ? '#e8b34b' : '#c25e3a');
  const out = get('-o', 'cover.png');
  const scale = Number(get('--scale', 2));

  const html = coverHtml({ title, subtitle: get('--subtitle', null), style, accent });
  const tmpHtml = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cover-')), 'cover.html');
  fs.writeFileSync(tmpHtml, html, 'utf8');

  const browser = await launchBrowser();
  try {
    const r = await shoot(browser, {
      url: pathToFileURL(tmpHtml).href,
      out, width: 900, scale,
      selector: '#cover',
    });
    console.log(`OK ${r.out} (${r.width}x${r.height} @${scale}x)`);
  } finally {
    browser.close();
    fs.rmSync(path.dirname(tmpHtml), { recursive: true, force: true });
  }
}

if (require.main === module) main().catch((e) => { console.error('FAIL ' + e.message); process.exit(1); });
