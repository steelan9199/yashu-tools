#!/usr/bin/env node
'use strict';
/**
 * factory.js — 配图工厂：丢进来一个文章目录，出整套公众号交付物。
 *
 * 目录契约:
 *   - 恰好一个草稿 .md（排除 *_表格转图.md 产物，多了少了都报错）
 *   - 任意个 *.html 配图源，各渲染成同名 .png（img1.html → img1.png，草稿按文件名引用）
 *     截图范围看 html 里的 <!-- shot: 选择器 -->，没写就整页
 *   - 没有 封面.png 且未给 --no-cover 时，用草稿一级标题自动出封面
 *
 * 流程: fontlint 全部 html → webshot 渲染（复用一个浏览器）→ 封面 → article.js（转表 + 自查）
 * 用法: node factory.js <目录 | 草稿.md> [--scale 2] [--width 900] [--no-cover] [--subtitle 副标题]
 * 退出码: 0 = 全套通过；1 = 任一步失败；2 = 参数/目录契约错误
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { launchBrowser, shoot, FONT_CSS } = require('./webshot');

function fail(msg, code = 1) { console.error(`FAIL ${msg}`); process.exit(code); }

function run(tool, args) {
  const r = spawnSync(process.execPath, [path.join(__dirname, tool), ...args], { stdio: 'inherit' });
  return r.status === 0;
}

function optVal(flags, name) {
  const i = flags.indexOf(name);
  return i >= 0 && flags[i + 1] && !flags[i + 1].startsWith('-') ? flags[i + 1] : null;
}

function main() {
  const argv = process.argv.slice(2);
  const flags = argv.filter((a) => a.startsWith('-'));
  const target = argv.find((a) => !a.startsWith('-'));
  if (!target) fail('用法: node factory.js <目录 | 草稿.md> [--scale 2] [--width 900] [--no-cover] [--subtitle 副标题]', 2);

  const dir = fs.existsSync(target) && fs.statSync(target).isDirectory() ? target : path.dirname(path.resolve(target));
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) fail(`目录不存在: ${dir}`, 2);

  // --- 目录契约：恰好一个草稿 ---
  const mds = fs.readdirSync(dir).filter((f) => /\.md$/i.test(f) && !_表格转图(f));
  function _表格转图(f) { return /_表格转图\.md$/i.test(f); }
  if (mds.length === 0) fail(`目录里没有草稿 md: ${dir}`, 2);
  if (mds.length > 1) fail(`目录里有 ${mds.length} 个草稿，只许一个: ${mds.join('、')}`, 2);
  const draft = path.join(dir, mds[0]);

  // --- 配图源 html ---
  const htmls = fs.readdirSync(dir).filter((f) => /\.html?$/i.test(f)).map((f) => path.join(dir, f));

  // 1) 字体铁律先卡，违规不渲染
  if (htmls.length) {
    console.log('== 第 1 步：字体铁律 ==');
    if (!run('fontlint.js', htmls)) fail('配图源没过字体铁律，先修 HTML 再来', 1);
  }

  // 2) 渲染：img1.html → img1.png，浏览器只启动一次
  if (htmls.length) {
    console.log('\n== 第 2 步：渲染配图 ==');
  }
  const images = [];
  const pend = (async () => {
    if (!htmls.length) return;
    const browser = await launchBrowser();
    try {
      for (const html of htmls) {
        const out = html.replace(/\.html?$/i, '.png');
        const text = fs.readFileSync(html, 'utf8');
        const m = text.match(/<!--\s*shot:\s*(.+?)\s*-->/);
        const selector = m ? m[1] : null;
        await shoot(browser, {
          url: pathToFileURL(html).href, out,
          width: optVal(flags, '--width') || 900,
          scale: optVal(flags, '--scale') || 2,
          fontCss: FONT_CSS, selector,
        });
        images.push(path.basename(out));
        console.log(`OK ${path.basename(html)} -> ${path.basename(out)}${selector ? ` (${selector})` : ' (整页)'}`);
      }
    } finally { browser.close(); }
  })();

  pend.then(() => {
    // 3) 封面：没有才补，标题取草稿一级标题
    const cover = path.join(dir, '封面.png');
    if (!flags.includes('--no-cover') && !fs.existsSync(cover)) {
      console.log('\n== 第 3 步：封面 ==');
      const text = fs.readFileSync(draft, 'utf8');
      const h1 = text.match(/^#\s+(.+)$/m);
      const title = h1 ? h1[1].trim() : path.basename(dir);
      const coverArgs = ['--title', title, '-o', cover, '--scale', optVal(flags, '--scale') || 2];
      const sub = optVal(flags, '--subtitle');
      if (sub) coverArgs.push('--subtitle', sub);
      if (!run('cover.js', coverArgs)) fail('封面生成失败', 1);
      console.log(`OK 封面.png（标题: ${title}）`);
    } else {
      console.log('\n== 第 3 步：封面 ==（跳过：已有或 --no-cover）');
    }

    // 4) 转表 + 自查，出交付版（透传 --scale/--width）
    console.log('\n== 第 4 步：文章流水线 ==');
    const pipeArgs = [draft];
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] === '--scale' || flags[i] === '--width') pipeArgs.push(flags[i], flags[i + 1]);
    }
    if (!run('article.js', pipeArgs)) fail('文章流水线未过，按 FAIL 逐条修', 1);
    const stem = path.basename(draft).replace(/\.md$/i, '');
    const deliverable = fs.existsSync(path.join(dir, `${stem}_表格转图.md`))
      ? `${stem}_表格转图.md` : mds[0];
    console.log(`\n== 配图工厂收工 ==`);
    console.log(`交付版: ${deliverable}`);
    console.log(`配图: ${images.length ? images.join('、') : '（无 html 源）'}`);
    console.log(`封面: ${fs.existsSync(cover) ? '封面.png' : '（无）'}`);
  }).catch((e) => fail(e.message, 1));
}

main();
