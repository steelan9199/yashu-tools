#!/usr/bin/env node
'use strict';
/**
 * preflight.js — 公众号文章交付自查（配合 mdtables.js 的收尾扫描）
 *
 * 检查项（对应公众号交付规则）:
 *   1. 残留表格       正文里不许还有 Markdown 表格（代码块内的不算）
 *   2. 配图数量       至少 2 张（2 张时提示「以 3 张为宜」）
 *   3. 配图格式       只许 jpg / jpeg / png，svg / gif / webp 一律拦截
 *   4. 配图引用       必须是同目录相对路径的标准语法 ![](xxx.png)，且文件真实存在
 *
 * 用法:
 *   node preflight.js <article.md> [--min-images 2]
 *
 * 退出码: 0 = 全部通过（含仅 WARN）；1 = 有 FAIL；2 = 参数错误
 */
const fs = require('fs');
const path = require('path');

const IMG_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const OK_EXT = new Set(['.jpg', '.jpeg', '.png']);

/** 去掉 ``` / ~~~ 围栏代码块和行内代码后的正文（配图扫描用，代码里的图片示例不算配图） */
function visibleText(src) {
  const kept = [];
  let inFence = false;
  for (const line of src.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (!inFence) kept.push(line.replace(/`[^`]*`/g, ''));
  }
  return kept.join('\n');
}

/** 跳过 ``` / ~~~ 围栏代码块后逐行扫描，找出残留表格（行号从 1 起） */
function findTables(lines) {
  const hits = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence || i + 1 >= lines.length) continue;
    if (lines[i].includes('|') && TABLE_SEP_RE.test(lines[i + 1])) hits.push(i + 1);
  }
  return hits;
}

function main() {
  const argv = process.argv.slice(2);
  const mdPath = argv.find((a) => !a.startsWith('-'));
  const get = (flag, def) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
  };
  if (!mdPath) {
    console.error('用法: node preflight.js <article.md> [--min-images 2]');
    process.exit(2);
  }
  if (!fs.existsSync(mdPath)) {
    console.error(`FAIL 文件不存在: ${mdPath}`);
    process.exit(1);
  }

  const src = fs.readFileSync(mdPath, 'utf8');
  const dir = path.dirname(mdPath);
  const fails = [];
  const warns = [];
  const bad = (msg) => fails.push(msg);
  const hint = (msg) => warns.push(msg);

  // 1. 残留表格
  const tables = findTables(src.split(/\r?\n/));
  if (tables.length > 0) bad(`残留表格 ${tables.length} 处（行 ${tables.join(', ')}）→ 先跑 mdtables.js`);
  else console.log('OK 无残留表格');

  // 2~4. 配图数量 / 格式 / 引用（代码块里的图片示例不算配图）
  const refs = [...visibleText(src).matchAll(IMG_RE)].map((m) => m[2]);
  if (refs.length === 0) bad('正文没有配图（至少 2 张）');
  else if (refs.length < Number(get('--min-images', 2))) bad(`配图仅 ${refs.length} 张，不足下限`);
  else if (refs.length === 2) hint(`配图 ${refs.length} 张，规则「以 3 张为宜」`);
  else console.log(`OK 配图 ${refs.length} 张`);

  for (const ref of refs) {
    const tag = `![](${ref})`;
    if (/^(https?:)?\/\//i.test(ref)) { bad(`${tag} 是外链，配图必须本地文件`); continue; }
    const ext = path.extname(ref).toLowerCase();
    if (!OK_EXT.has(ext)) { bad(`${tag} 格式 ${ext || '(无扩展名)'} 不合规，只许 jpg/png`); continue; }
    if (ref.includes('/') || ref.includes('\\')) { bad(`${tag} 带路径，须与 .md 同目录平级引用文件名`); continue; }
    if (!fs.existsSync(path.join(dir, ref))) bad(`${tag} 文件不存在`);
  }

  for (const w of warns) console.log(`WARN ${w}`);
  if (fails.length > 0) {
    for (const f of fails) console.log(`FAIL ${f}`);
    process.exit(1);
  }
  console.log('PASS 自查通过');
}

main();
