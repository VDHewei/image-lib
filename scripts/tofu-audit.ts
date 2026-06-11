#!/usr/bin/env bun
/**
 * 豆腐块(missing glyph □)审计脚本
 *
 * 覆盖测试套中所有涉及中文的用例字体路径,逐字符做字形级检测:
 *   1. 用与测试完全相同的 loadFont() 解析出字体族
 *   2. 把每个 CJK 字符用该字体族渲染到画布
 *   3. 与同字体族下"必然无字形"的码位(U+0378 未分配 / U+FFFE 非字符)的
 *      .notdef 豆腐渲染做像素签名比对 —— 签名一致 = 豆腐块
 *
 * 用法: bun run scripts/tofu-audit.ts
 * 退出码: 0 = 全部正常; 1 = 检出豆腐块
 */
import { createCanvas } from '@napi-rs/canvas';
import path from 'node:path';
import { loadFont } from '../src/main';

const ROOT = path.resolve(import.meta.dirname, '..');
const CROP_BG = path.join(ROOT, 'tests', 'data', 'cropped-bg.png'); // loadFont 只读 options,背景图不实际使用

// 与 tests/create_dynamic_stamp.test.ts 保持一致
const NOTO_SANS_SC_URL =
  'https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-sc@5/files/noto-sans-sc-chinese-simplified-700-normal.woff';

//  像素签名 ────────────────────────────────────────────────────────────────────

type Sig = { count: number; w: number; h: number };

const CELL = 140;
function renderSig(family: string, ch: string): Sig {
  const c = createCanvas(CELL, CELL);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, CELL, CELL);
  ctx.fillStyle = '#000000';
  ctx.font = `100px ${family}`;
  ctx.fillText(ch, 10, 110);
  const img = ctx.getImageData(0, 0, CELL, CELL);
  let count = 0, minX = CELL, maxX = -1, minY = CELL, maxY = -1;
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      if (img.data[(y * CELL + x) * 4]! < 128) {
        count++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  return { count, w: maxX < 0 ? 0 : maxX - minX + 1, h: maxY < 0 ? 0 : maxY - minY + 1 };
}

function sigClose(a: Sig, b: Sig): boolean {
  if (b.count === 0) return a.count === 0;
  return Math.abs(a.count - b.count) / b.count < 0.05
    && Math.abs(a.w - b.w) <= 2
    && Math.abs(a.h - b.h) <= 2;
}

/** 判定字符 ch 在 family 下是否渲染为豆腐块/空白 */
function checkGlyph(family: string, ch: string, tofuSigs: Sig[]): 'ok' | 'tofu' | 'blank' {
  const sig = renderSig(family, ch);
  if (sig.count < 10) return 'blank';
  for (const t of tofuSigs) {
    if (t.count >= 10 && sigClose(sig, t)) return 'tofu';
  }
  return 'ok';
}

//  审计场景(复刻测试用例的字体路径) ─────────────────────────────────────────

/** 测试套里所有含中文的文本样本 */
const TEXTS = [
  '草',                       // 中文单字
  '草稿',                     // 中文短词 / stamp-on-cropped-bg / region 系列
  '内部资料请勿外传',          // 中文长句
  '草稿 DRAFT v1.0',          // 中英混合
  'Draft 草稿 #2026-06',      // 中英数字符号
  'Draft  草稿',              // 含 emoji 后备(emoji 已剥离)
  'A中B文C混D合',             // 长度边界用例的循环单元
  '超长草稿文字测试 DRAFT 2026-06-10', // overflow 系列
];

/** 提取唯一 CJK 字符 */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const uniqueCJK = [...new Set(TEXTS.join('').split('').filter(c => CJK_RE.test(c)))];

type Scenario = { label: string; resolve: () => Promise<string> };

const SCENARIOS: Scenario[] = [
  {
    // 测试: '使用 crop 产物作背景生成中文印章' / '多种字体源对比 > 系统字体族'
    label: '系统字体链 Arial+YaHei (fontFamily 显式)',
    resolve: () => loadFont({ backgroundPath: CROP_BG, text: '草稿', fontFamily: 'Arial, "Microsoft YaHei", sans-serif' }),
  },
  {
    // 测试: SAMPLES_LANG / SAMPLES_LEN / region 系列 / overflow 系列 (远程 NotoSansSC)
    label: '远程字体 NotoSansSC (fontURL)',
    resolve: () => loadFont({ backgroundPath: CROP_BG, text: '草稿', fontURL: NOTO_SANS_SC_URL, fontName: 'NotoSansSC' }),
  },
  {
    // bin.ts gen 默认路径: 未指定任何字体源 → 智能兜底
    label: 'CLI gen 默认 (智能兜底,文本含 CJK)',
    resolve: () => loadFont({ backgroundPath: CROP_BG, text: '草稿' }),
  },
  {
    // 用户报障场景: Latin 链 + 中文 → 应自动追加 CJK 兜底
    label: 'Latin 链自动补 CJK (Georgia+Times)',
    resolve: () => loadFont({ backgroundPath: CROP_BG, text: '草稿', fontFamily: 'Georgia, "Times New Roman", serif' }),
  },
];

//  主流程 ──────────────────────────────────────────────────────────────────────

let foundTofu = false;

console.log(`待检字符 (${uniqueCJK.length}): ${uniqueCJK.join(' ')}\n`);

for (const sc of SCENARIOS) {
  const family = await sc.resolve();
  // 同字体族下的 .notdef 豆腐参照(未分配码位 + 非字符,双保险)
  const tofuSigs = [renderSig(family, '\u0378'), renderSig(family, '\uFFFE')];

  const bad: string[] = [];
  const blank: string[] = [];
  for (const ch of uniqueCJK) {
    const r = checkGlyph(family, ch, tofuSigs);
    if (r === 'tofu') bad.push(ch);
    else if (r === 'blank') blank.push(ch);
  }

  const status = bad.length === 0 && blank.length === 0 ? 'PASS' : 'FAIL';
  if (status === 'FAIL') foundTofu = true;
  console.log(`[${status}] ${sc.label}`);
  console.log(`       family = ${family}`);
  console.log(`       tofu参照 count=${tofuSigs[0]!.count}/${tofuSigs[1]!.count}`);
  if (bad.length)   console.log(`       豆腐块: ${bad.join(' ')}`);
  if (blank.length) console.log(`       空白:   ${blank.join(' ')}`);
  console.log();
}

if (foundTofu) {
  console.error('[X] 检出豆腐块!');
  process.exit(1);
}
console.log('[OK] 所有中文测试场景字形渲染正常,无豆腐块');

