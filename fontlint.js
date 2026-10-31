#!/usr/bin/env node
'use strict';
/**
 * fontlint.js — 字体铁律检查（对外展示的东西只用 LXGW WenKai GB）
 *
 * 检查项（对应全局字体规则）:
 *   1. font-family 只许写 'LXGW WenKai GB'（或注册中文名 '霞鹜文楷 GB'），
 *      出现第二个字体名、通用关键字（sans-serif / serif / monospace / system-ui …）一律违规
 *   2. font-weight 只许 100–500 / normal / lighter；600、700、bold 都是合成加粗，违规
 *   3. font 简写里夹带 bold / ≥600 数字同样违规
 *
 * 适用文件: .html / .css / .md（md 里的内联样式与代码示例也查——对外交付前就该干净）
 *
 * 用法:
 *   node fontlint.js <file...>
 *
 * 退出码: 0 = 全部合规；1 = 有违规；2 = 参数错误
 */
const fs = require('fs');
const path = require('path');

const ALLOWED = new Set(['lxgw wenkai gb', '霞鹜文楷 gb']);
const FAMILY_RE = /font-family\s*:\s*([^;}]+)/gi;
const WEIGHT_RE = /font-weight\s*:\s*([^;}]+)/gi;
const SHORT_RE = /(?<![-a-z])font\s*:\s*([^;}]+)/gi;

function clean(v) { return v.replace(/!important/gi, '').trim(); }

function checkFamily(file, lineNo, decl, out) {
  const tokens = clean(decl).split(',').map((t) => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  if (tokens.length === 0) { out.push(`FAIL ${file}:${lineNo} font-family 为空`); return; }
  for (const t of tokens) {
    if (!ALLOWED.has(t.toLowerCase())) {
      out.push(`FAIL ${file}:${lineNo} 出现第二字体「${t}」（只许 LXGW WenKai GB，不许兜底）`);
    }
  }
}

function checkWeight(file, lineNo, decl, out) {
  const v = clean(decl).toLowerCase();
  if (/^\d+$/.test(v)) {
    if (Number(v) >= 600) out.push(`FAIL ${file}:${lineNo} font-weight:${v} 会合成加粗，只许 300/400/500`);
  } else if (v === 'bold' || v === 'bolder') {
    out.push(`FAIL ${file}:${lineNo} font-weight:${v} 是合成加粗，只许 300/400/500`);
  } else if (!['normal', 'lighter'].includes(v) && !/^\d+$/.test(v)) {
    out.push(`FAIL ${file}:${lineNo} font-weight:「${decl.trim()}」看不懂，人工确认`);
  }
}

function checkShorthand(file, lineNo, decl, out) {
  const v = clean(decl);
  const m = v.match(/(?:^|\s)(bold(?:er)?|\d{3,4})(?=\s|\/|$)/);
  if (!m) return;
  if (/^bold/.test(m[1]) || Number(m[1]) >= 600) {
    out.push(`FAIL ${file}:${lineNo} font 简写夹带「${m[1]}」加粗，只许 300/400/500`);
  }
}

function lintFile(file) {
  const out = [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    const lineNo = i + 1;
    for (const m of line.matchAll(FAMILY_RE)) checkFamily(file, lineNo, m[1], out);
    for (const m of line.matchAll(WEIGHT_RE)) checkWeight(file, lineNo, m[1], out);
    for (const m of line.matchAll(SHORT_RE)) checkShorthand(file, lineNo, m[1], out);
  });
  if (out.length === 0) console.log(`OK ${path.basename(file)} 字体合规`);
  return out;
}

function main() {
  const files = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  if (files.length === 0) {
    console.error('用法: node fontlint.js <file...>   # .html / .css / .md');
    process.exit(2);
  }
  const fails = [];
  for (const f of files) {
    if (!fs.existsSync(f)) { fails.push(`FAIL ${f} 文件不存在`); continue; }
    fails.push(...lintFile(f));
  }
  for (const f of fails) console.log(f);
  if (fails.length > 0) process.exit(1);
  console.log('PASS 字体铁律全过');
}

main();
