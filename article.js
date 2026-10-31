#!/usr/bin/env node
'use strict';
/**
 * article.js — 公众号文章一键流水线：转表 → 自查，一条命令出交付版。
 *
 * 步骤:
 *   1. mdtables.js  把草稿里的表格逐个转 PNG，生成 <stem>_表格转图.md（草稿不动）
 *   2. preflight.js 对交付版做收尾自查（残留表格 / 配图数量格式 / 引用存在性）
 *
 * 用法:
 *   node article.js <draft.md> [--scale 2] [--width 1200]
 *
 * 交付版: 有表格 → <stem>_表格转图.md；无表格 → 原文件本身。
 * 退出码: 0 = 自查通过（含仅 WARN）；1 = 自查未过或中途失败；2 = 参数错误
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function run(tool, args) {
  const r = spawnSync(process.execPath, [path.join(__dirname, tool), ...args], { stdio: 'inherit' });
  return r.status === 0;
}

function main() {
  const argv = process.argv.slice(2);
  const md = argv.find((a) => !a.startsWith('-'));
  if (!md) {
    console.error('用法: node article.js <draft.md> [--scale 2] [--width 1200]');
    process.exit(2);
  }
  if (!fs.existsSync(md)) { console.error(`FAIL 文件不存在: ${md}`); process.exit(1); }

  console.log('== 第 1 步：表格转图 ==');
  if (!run('mdtables.js', argv)) {
    console.error('FAIL 转表失败，流水线中止');
    process.exit(1);
  }

  const stem = path.basename(md).replace(/\.md$/i, '');
  const converted = path.join(path.dirname(md), `${stem}_表格转图.md`);
  const deliverable = fs.existsSync(converted) ? converted : md;
  console.log(`\n== 第 2 步：交付自查（${path.basename(deliverable)}）==`);
  if (!run('preflight.js', [deliverable, ...argv.filter((a) => a.startsWith('-'))])) {
    console.error('\nFAIL 自查未过，按 FAIL 逐条修完再跑一遍');
    process.exit(1);
  }

  console.log(`\nPASS 流水线通过，交付版: ${deliverable}`);
}

main();
