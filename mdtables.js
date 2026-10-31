#!/usr/bin/env node
'use strict';
/**
 * mdtables.js — 把 Markdown 里的表格逐个转成 PNG 图片，并把原位替换成 ![](xxx.png)
 * （公众号交付规则：正文表格一律转图，数据一字不差，图与 .md 同目录）
 *
 * 用法:
 *   node mdtables.js <article.md> [--out <dir>] [--scale 2] [--width 1200]
 *
 * 产出:
 *   <stem>_t1.png, <stem>_t2.png ...   与 .md 同目录（或 --out 指定目录）
 *   <stem>_表格转图.md                 表格已替换为图片引用，原文件不动
 *
 * 退出码: 0 = 成功（含「没找到表格」）；1 = 失败
 */
const fs = require('fs');
const path = require('path');
const { launchBrowser, shoot } = require('./webshot');
const { pathToFileURL } = require('url');

function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function inline(s) {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/** 解析一行表格行 → 单元格数组（容忍首尾竖线缺失、转义 \| 暂不支持） */
function parseRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

/** 判断是否为表头分隔行，并提取每列对齐方式 */
function parseAlign(line) {
  if (!/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)) return null;
  return parseRow(line).map((c) => {
    const l = c.startsWith(':'), r = c.endsWith(':');
    return l && r ? 'center' : r ? 'right' : 'left';
  });
}

/** 找出 md 里所有表格块，返回 [{lines, start, end}]（end 为开区间）。围栏代码块里的表格不算。 */
function findTables(lines) {
  const tables = [];
  let inFence = false;
  for (let i = 0; i + 1 < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    const align = parseAlign(lines[i + 1]);
    if (!align || !lines[i].includes('|')) continue;
    let j = i + 2;
    while (j < lines.length && lines[j].trim().startsWith('|')) j++;
    tables.push({ lines: lines.slice(i, j), start: i, end: j, align });
    i = j - 1;
  }
  return tables;
}

function tableHtml(rows, align) {
  const [head, ...body] = rows;
  const th = head.map((c, i) => `<th style="text-align:${align[i] || 'left'}">${inline(c)}</th>`).join('');
  const tr = body
    .map((row) => `<tr>${row.map((c, i) => `<td style="text-align:${align[i] || 'left'}">${inline(c)}</td>`).join('')}</tr>`)
    .join('\n');
  return `<table><thead><tr>${th}</tr></thead><tbody>\n${tr}\n</tbody></table>`;
}

const PAGE_CSS = `
  body { margin: 0; background: #fff; font-family: 'LXGW WenKai GB' !important; }
  #shot { display: inline-block; background: #fff; padding: 20px; }
  table { border-collapse: collapse; font-size: 16px; font-weight: 400; color: #222; line-height: 1.6; }
  th, td { border: 1px solid #d9d9d9; padding: 8px 16px; }
  th { background: #f2f2f2; font-weight: 500; }
  tr:nth-child(even) td { background: #fafafa; }
`;

async function main() {
  const argv = process.argv.slice(2);
  const mdPath = argv.find((a) => !a.startsWith('-'));
  const get = (flag, def) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
  };
  if (!mdPath) {
    console.error('用法: node mdtables.js <article.md> [--out dir] [--scale 2] [--width 1200]');
    process.exit(2);
  }
  const src = fs.readFileSync(mdPath, 'utf8');
  const lines = src.split(/\r?\n/);
  const tables = findTables(lines);
  const stem = path.basename(mdPath).replace(/\.md$/i, '');
  const outDir = get('--out', path.dirname(mdPath));
  fs.mkdirSync(outDir, { recursive: true });
  if (tables.length === 0) {
    console.log('OK 文章里没有表格，不用转');
    return;
  }

  const browser = await launchBrowser();
  const images = [];
  try {
    for (let k = 0; k < tables.length; k++) {
      const png = path.join(outDir, `${stem}_t${k + 1}.png`);
      const rows = tables[k].lines.filter((_, i) => i !== 1).map(parseRow); // 跳过分隔行
      const html = `<!doctype html><meta charset="utf-8"><style>${PAGE_CSS}</style><div id="shot">${tableHtml(rows, tables[k].align)}</div>`;
      const tmpHtml = path.join(outDir, `.${stem}_t${k + 1}.html`);
      fs.writeFileSync(tmpHtml, html, 'utf8');
      await shoot(browser, {
        url: pathToFileURL(tmpHtml).href,
        out: png,
        width: Number(get('--width', 1200)),
        scale: Number(get('--scale', 2)),
        selector: '#shot',
      });
      fs.rmSync(tmpHtml, { force: true });
      images.push(png);
      console.log(`OK 表${k + 1} -> ${png}`);
    }
  } finally {
    browser.close();
  }

  // 原位替换成图片引用（相对路径，与公众号规则一致）
  let idx = tables.length - 1;
  const newLines = lines.slice();
  for (; idx >= 0; idx--) {
    const t = tables[idx];
    const name = path.relative(path.dirname(mdPath), images[idx]).replace(/\\/g, '/');
    newLines.splice(t.start, t.end - t.start, `![](${name})`);
  }
  const outMd = path.join(path.dirname(mdPath), `${stem}_表格转图.md`);
  fs.writeFileSync(outMd, newLines.join('\n'), 'utf8');
  console.log(`OK ${outMd}（原文件未动）`);
}

if (require.main === module) main().catch((e) => { console.error('FAIL ' + e.message); process.exit(1); });
