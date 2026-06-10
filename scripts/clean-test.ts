#!/usr/bin/env bun
/**
 * 一键清理测试产物与字体缓存
 *
 * 默认清理:
 *   - tests/data/        (测试生成的图片)
 *   - src/font_cache/    (loadFont 远程下载缓存)
 *   - font_cache/        (旧版本残留缓存)
 *
 * 加 --all 还会清理:
 *   - out/               (CLI/demo 输出)
 *   - dist/              (build 产物)
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
const cleanAll = process.argv.includes('--all');

const DEFAULT_TARGETS = [
  'tests/data',
  'src/font_cache',
  'font_cache',
  'out'
];

const ALL_TARGETS = [
  ...DEFAULT_TARGETS,
  'out',
  'dist',
];

const targets = cleanAll ? ALL_TARGETS : DEFAULT_TARGETS;

let cleaned = 0;
let skipped = 0;

for (const rel of targets) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    console.log(`  跳过 (不存在): ${rel}`);
    skipped++;
    continue;
  }
  try {
    fs.rmSync(abs, { recursive: true, force: true });
    console.log(`OK 已清理: ${rel}`);
    cleaned++;
  } catch (e) {
    console.error(`ERR 清理失败: ${rel}  ${(e as Error).message}`);
  }
}

console.log(`\n汇总: ${cleaned} 个目录被删除, ${skipped} 个跳过`);