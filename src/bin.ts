#!/usr/bin/env bun
/**
 * image_lib CLI
 *
 * 子命令：
 *   stamp  生成动态印章图片（支持中英文、自定义字体/字号/颜色）
 *   crop   抠图：从源图提取边框，生成中间透明的"无字底图"
 *   gen    一键端到端：抠图 + 在抠除区域内添加文字 + 输出印章图片
 *
 * 通用 flags：
 *   -h, --help     显示帮助
 *   -v, --version  显示版本号
 *
 * 详细 flags 见 `bun src/bin.ts <subcommand> --help`
 */
import path from 'path';
import fs from 'fs';
import os from 'os';
import {
  generateDynamicStamp,
  cropTransparentBackground,
  getExtForFormat,
  type EncodeFormat,
  type EncodeOptions,
  type GenerateStampOptions,
  type CropOptions,
  type Region,
} from './main';

const VERSION = '0.1.0';

//  轻量参数解析（避免引入 commander/yargs，保持零依赖） 
type ParsedArgs = {
  _: string[];
  flags: Record<string, string | boolean>;
};

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else if (a.startsWith('-') && a.length > 1) {
      const key = a.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { _: positional, flags };
}

function pickFlag(p: ParsedArgs, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = p.flags[k];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

function pickBool(p: ParsedArgs, ...keys: string[]): boolean {
  return keys.some(k => p.flags[k] === true || p.flags[k] === 'true');
}

function printRootHelp(): void {
  console.log(`image_lib v${VERSION}

USAGE:
  image-lib <command> [options]

COMMANDS:
  stamp     生成动态印章图片（自适应文本宽度）
  crop      抠图：从源图提取边框，生成中间透明的底图
  gen       端到端：抠图 + 在抠除区域内添加文字 + 输出印章图片（一步到位）

GLOBAL OPTIONS:
  -h, --help     显示帮助
  -v, --version  显示版本

EXAMPLES:
  image-lib stamp --bg images/draft.png --text "草稿" --out out/stamp.png
  image-lib crop  --src images/draft.png --out out/clean-bg.png
  image-lib gen   --src images/draft.png --text "Approved" --out out/final.png
  image-lib stamp --help
`);
}

function printStampHelp(): void {
  console.log(`image-lib stamp  生成动态印章图片

USAGE:
  image-lib stamp --bg <path> --text <string> [options]

REQUIRED:
  --bg, --background <path>   背景图路径（如 images/draft.png）
  --text <string>             印章文字（支持中文/英文/混合，1-255 字）

OUTPUT:
  --out, --output <path>      输出路径（默认 out/stamp.<ext>）
  --format <fmt>              png|jpeg|webp|avif|gif（默认 png）
  --quality <0-100>           jpeg/webp/gif 质量

FONT:
  --font-url <url>            远程字体 URL（优先级最高）
  --font-file <path>          本地字体文件路径
  --font-family <css>         指定字体族（**单一字体名**，如 "Microsoft YaHei"）
                                ⚠️ Skia 不做 per-glyph 回退,逗号链(如 "Arial, YaHei")
                                只取第一个。不指定时按文本含 CJK 与否自动挑平台字体
  --font-name <name>          注册到 GlobalFonts 的字体名
  --font-size <size>          字号；支持 32 / 32px / 24pt（pt→px：×96/72）
                                不指定时跟随 textRegion.height-margin；否则默认 40px
  --font-color <#hex>         字体颜色（默认 #FF99A8）
  --no-bold                   关闭加粗

SPECKLE (橡皮章/屏幕雪花斑驳效果):
  --speckle-mode <m>          none|uniform|per-char（默认 per-char）
  --speckle-density <0-1>     目标覆盖率（默认 0.0075 = 0.75%，推荐 0.005-0.01）
  --speckle-size <px>         多边形基础半径（默认 1.2，实际形状是 4-7 顶点不规则多边形）
  --speckle-color <css>       斑点颜色（默认 transparent 透明镂空；可传 #FFFFFF / #000000 等实色）
  --speckle-seed <int>        固定随机种子（测试可复现）
  --no-speckle                等价于 --speckle-mode none

LAYOUT:
  --margin <n>                统一四边距（默认 20）
  --margin-top/right/bottom/left <n>   单独指定

TEXT REGION (文字填充矩形，通常配合 crop 输出使用):
  --text-region <x,y,w,h>     文字填充矩形（绝对像素，相对背景图）
                                配合 crop 的 region 输出可让文字精确落入"洞"内
  --no-stretch                文本超出 region 时不拉伸画布（默认拉伸）
  --overflow <strategy>       不拉伸时的策略：shrink（默认）|clip|overflow

EXAMPLES:
  image-lib stamp --bg images/draft.png --text "草稿" --out out/zh.png
  image-lib stamp --bg images/draft.png --text "DRAFT" --font-size 60 --font-color "#FF0000"
  image-lib stamp --bg out/clean-bg.png --text "草稿 v1.0" \\
    --text-region "30,15,180,50"          # 文字精确落在矩形 (30,15) 180x50 内
  image-lib stamp --bg out/clean-bg.png --text "超长的印章文字内容" \\
    --text-region "30,15,180,50" --no-stretch --overflow shrink   # 字号自动缩小
`);
}

function printCropHelp(): void {
  console.log(`image-lib crop  颜色定位抠图：按颜色框选区域抠除框内或框外

USAGE:
  image-lib crop --src <path> [options]

REQUIRED:
  --src, --source <path>      源图片路径

OUTPUT:
  --out, --output <path>      输出路径（默认 out/clean-bg.<ext>，建议 .png 保留透明度）
  --format <fmt>              png|jpeg|webp|avif|gif（默认 png）
  --quality <0~100>           编码质量（jpeg/webp/gif 生效）

REGION (保留模式):
  --keep <outside|inside>     保留框外或框内，默认 outside
                                outside: 保留框外，框内整块抠透明（输出 = 源图尺寸）
                                inside : 保留框内并裁剪（输出 = 框尺寸）

TARGET (框选定位):
  --target-color <r,g,b>      框选颜色，默认 255,215,0 (黄色)
  --target-tolerance <n>      框选色容差（欧氏距离），默认 80
  --padding <px>              padding，默认 0
                                outside 模式：向内收缩，避免抠掉边框本身
                                inside  模式：向外扩展裁剪边界

TRANSPARENT (额外透明化，作用于保留区域):
  --transparent-color <r,g,b> 透明化颜色（默认: inside 模式=白色; outside 模式=不启用）
  --transparent-tolerance <n> 容差，默认 40
  --no-transparent            显式关闭颜色透明化

EXAMPLES:
  # 默认：保留框外（去掉黄色框内 DRAFT 文字），输出与源图同尺寸
  image-lib crop --src images/draft.png --out out/outside.png

  # 切换为保留框内 + 抠白底：得到只剩"黄框+粉DRAFT"的小卡片
  image-lib crop --src images/draft.png --out out/inside.png --keep inside

  # 保留框外，同时把背景白色也抠透明
  image-lib crop --src images/draft.png --out out/clean.png --transparent-color "255,255,255"
`);
}

function printGenHelp(): void {
  console.log(`image-lib gen  端到端：抠图 → 在抠除区域内添加文字 → 输出印章图片

USAGE:
  image-lib gen --src <path> --text <string> [options]

PIPELINE:
  1. cropTransparentBackground(--src)  得到 region + 透明底图
  2. generateDynamicStamp(底图, text, textRegion=region)  落字
  3. 写入 --out（最终印章）

REQUIRED:
  --src, --source <path>      源图路径（如 images/draft.png）
  --text <string>             印章文字（1-255 字）

OUTPUT:
  --out, --output <path>      最终输出路径（默认 out/gen-stamp.<ext>）
  --intermediate <path>       同时把抠图中间产物落盘到此路径（不指定则用临时文件并清理）
  --keep-intermediate         保留自动生成的临时中间产物（不和 --intermediate 同时使用）
  --format <fmt>              输出格式 png|jpeg|webp|avif|gif（默认 png）
  --quality <0-100>           jpeg/webp/gif 质量

CROP FLAGS (透传给 crop 步骤):
  --keep <outside|inside>     保留框外/框内（默认 outside）
  --target-color <r,g,b>      框选颜色（默认 255,215,0 黄色）
  --target-tolerance <n>      框选容差（默认 80）
  --transparent-color <r,g,b> 额外透明化颜色（outside 模式默认不启用；inside 模式默认白色）
  --transparent-tolerance <n> 透明容差（默认 40）
  --no-transparent            显式关闭颜色透明化
  --padding <px>              outside 内缩 / inside 外扩（默认 0）

FONT (与 stamp 完全一致；gen 专属默认：size=24pt=32px，family 智能挑选):
  --font-url <url>            远程字体 URL（优先级最高）
  --font-file <path>          本地字体文件路径
  --font-family <css>         指定字体族（**单一字体名**，如 "Microsoft YaHei"）
                                ⚠️ Skia 不做 per-glyph 回退,所以传逗号链如
                                "Arial, Microsoft YaHei" 只会用 Arial 第一个,
                                中文字符会变成豆腐块 □。请只传一个家族名。
                                不指定时按文本内容自动挑:
                                  含中日韩 → 平台 CJK 字体(YaHei / PingFang SC / Noto CJK)
                                  否则     → 平台 Latin 字体(Arial / Helvetica / DejaVu Sans)
  --font-name <name>          注册到 GlobalFonts 的字体名
  --font-size <size>          字号；支持 32 / 32px / 24pt（pt→px：×96/72）
                                gen 默认 24pt = 32px；指定后覆盖 region 自动推断
  --font-color <#hex>         字体颜色（默认 #FF99A8）
  --no-bold                   关闭加粗

OTHER STAMP FLAGS (透传；textRegion 自动取 crop 返回的 region):
  --margin* / --speckle-* / --no-speckle / --no-stretch / --overflow
  详见 'image-lib stamp --help'

EXAMPLES:
  # 最简单：用 images/draft.png 的黄框抠出来，在洞里写 "Approved"
  # 默认字体：sans-serif，24pt = 32px
  image-lib gen --src images/draft.png --text "Approved" --out out/approved.png

  # 同时保留中间抠图产物便于检查
  image-lib gen --src images/draft.png --text "草稿" \\
    --out out/zh.png --intermediate out/zh-crop.png

  # 显式指定字号（支持 pt / px）
  image-lib gen --src images/draft.png --text "DRAFT" --out out/draft.png \\
    --font-size 30pt --font-color "#FF0000"

  # 自定义系统字体族
  image-lib gen --src images/draft.png --text "Confidential" --out out/cf.png \\
    --font-family 'Georgia, "Times New Roman", serif'

  # 自定义字体 + 关闭斑驳 + jpeg 输出
  image-lib gen --src images/draft.png --text "DRAFT" --out out/draft.jpg \\
    --format jpeg --quality 90 --font-color "#FF0000" --no-speckle

  # 复现实验：固定 seed
  image-lib gen --src images/draft.png --text "Pending" \\
    --out out/pending.png --speckle-seed 42
`);
}

/** 解析 "r,g,b" 字符串为 RGB 对象 */
function parseRGB(str: string, name: string): { r: number; g: number; b: number } {
  const parts = str.split(',').map(s => Number(s.trim()));
  if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) {
    throw new Error(`--${name} 格式应为 "r,g,b"，实际收到 "${str}"`);
  }
  return { r: parts[0]!, g: parts[1]!, b: parts[2]! };
}

/** 解析 "x,y,w,h" 字符串为 Region 对象 */
function parseRegion(str: string, name: string): { x: number; y: number; width: number; height: number } {
  const parts = str.split(',').map(s => Number(s.trim()));
  if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) {
    throw new Error(`--${name} 格式应为 "x,y,w,h"，实际收到 "${str}"`);
  }
  return { x: parts[0]!, y: parts[1]!, width: parts[2]!, height: parts[3]! };
}

/**
 * 解析字号字符串，支持 px 与 pt 单位
 *
 *   "40"     → 40    (无单位默认 px)
 *   "40px"   → 40
 *   "24pt"   → 32    (24 × 96/72 = 32)
 *   "24.5pt" → 33    (四舍五入到整数像素)
 *
 * pt → px 换算：1pt = 1/72 inch，Canvas/浏览器使用 96 DPI，故 1pt = 96/72 = 4/3 px
 */
function parseFontSize(input: string, name: string): number {
  const trimmed = input.trim().toLowerCase();
  const m = /^(\d+(?:\.\d+)?)(px|pt)?$/.exec(trimmed);
  if (!m) {
    throw new Error(`--${name} 格式无效："${input}"，支持示例：32 / 32px / 24pt`);
  }
  const value = Number(m[1]);
  const unit = m[2] ?? 'px';
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${name} 必须是正数，实际 "${input}"`);
  }
  return unit === 'pt' ? Math.round(value * 96 / 72) : value;
}

function parseMargin(p: ParsedArgs): { top: number; right: number; bottom: number; left: number } {
  const uniform = pickFlag(p, 'margin');
  const def = uniform !== undefined ? Number(uniform) : 20;
  return {
    top: Number(pickFlag(p, 'margin-top') ?? def),
    right: Number(pickFlag(p, 'margin-right') ?? def),
    bottom: Number(pickFlag(p, 'margin-bottom') ?? def),
    left: Number(pickFlag(p, 'margin-left') ?? def),
  };
}

/**
 * 从 ParsedArgs 构造 generateDynamicStamp 的完整 options
 *
 * @param bg                    背景图路径（必填，由调用方显式传入）
 * @param text                  印章文字（必填，由调用方显式传入）
 * @param encodeOptions         编码配置（已在调用方根据 --format / --quality 组装）
 * @param overrideTextRegion    若提供，则覆盖 --text-region flag（gen 子命令用 crop 返回的 region）
 *
 * 注：此函数只解析 stamp 相关 flag，不读取 --bg / --text / --out / --format / --quality
 */
function buildStampOptions(
  p: ParsedArgs,
  bg: string,
  text: string,
  encodeOptions: EncodeFormat | EncodeOptions,
  overrideTextRegion?: Region,
): GenerateStampOptions {
  // —— textRegion / 拉伸策略 ——
  const textRegionStr = pickFlag(p, 'text-region');
  const textRegion = overrideTextRegion
    ?? (textRegionStr !== undefined ? parseRegion(textRegionStr, 'text-region') : undefined);
  const noStretch = pickBool(p, 'no-stretch');
  const overflowRaw = pickFlag(p, 'overflow');
  if (overflowRaw !== undefined && !['shrink', 'clip', 'overflow'].includes(overflowRaw)) {
    throw new Error(`--overflow 必须是 'shrink' | 'clip' | 'overflow'，实际 "${overflowRaw}"`);
  }
  const overflowStrategy = overflowRaw as ('shrink' | 'clip' | 'overflow' | undefined);

  // —— 斑驳效果 ——
  const noSpeckle = pickBool(p, 'no-speckle');
  const speckleModeRaw = pickFlag(p, 'speckle-mode');
  if (speckleModeRaw !== undefined && !['none', 'uniform', 'per-char'].includes(speckleModeRaw)) {
    throw new Error(`--speckle-mode 必须是 'none'|'uniform'|'per-char'，实际 "${speckleModeRaw}"`);
  }
  const speckleMode = noSpeckle
    ? 'none' as const
    : (speckleModeRaw as ('none' | 'uniform' | 'per-char' | undefined));
  const speckleDensityStr = pickFlag(p, 'speckle-density');
  const speckleSizeStr = pickFlag(p, 'speckle-size');
  const speckleColor = pickFlag(p, 'speckle-color');
  const speckleSeedStr = pickFlag(p, 'speckle-seed');

  // —— 字体 ——
  const fontSizeStr = pickFlag(p, 'font-size');
  const fontSize = fontSizeStr !== undefined ? parseFontSize(fontSizeStr, 'font-size') : undefined;

  return {
    backgroundPath: bg,
    text,
    fontURL: pickFlag(p, 'font-url'),
    fontFilePath: pickFlag(p, 'font-file'),
    fontFamily: pickFlag(p, 'font-family'),
    fontName: pickFlag(p, 'font-name'),
    fontSize,
    fontColor: pickFlag(p, 'font-color'),
    fontBold: !pickBool(p, 'no-bold'),
    margin: parseMargin(p),
    encodeOptions,
    textRegion,
    stretchTextRegion: textRegion ? !noStretch : undefined,
    overflowStrategy,
    speckleMode,
    speckleDensity: speckleDensityStr !== undefined ? Number(speckleDensityStr) : undefined,
    speckleSize: speckleSizeStr !== undefined ? Number(speckleSizeStr) : undefined,
    speckleColor,
    speckleSeed: speckleSeedStr !== undefined ? Number(speckleSeedStr) : undefined,
  };
}

/**
 * 从 ParsedArgs 构造 cropTransparentBackground 的完整 options
 *
 * @param src               源图路径（必填，由调用方显式传入）
 * @param outputPath        输出路径（可选；undefined 时 crop 只返回 buffer 不落盘）
 * @param encodeOptions     编码配置
 *
 * 注：此函数只解析 crop 相关 flag，不读取 --src / --out / --format / --quality
 */
function buildCropOptions(
  p: ParsedArgs,
  src: string,
  outputPath: string | undefined,
  encodeOptions: EncodeFormat | EncodeOptions,
): CropOptions {
  // —— 保留区域模式 ——
  const keepRaw = pickFlag(p, 'keep');
  if (keepRaw !== undefined && keepRaw !== 'inside' && keepRaw !== 'outside') {
    throw new Error(`--keep 必须是 'inside' 或 'outside'，实际 "${keepRaw}"`);
  }
  const keepRegion = keepRaw as ('inside' | 'outside' | undefined);

  const targetColorStr = pickFlag(p, 'target-color');
  const transparentColorStr = pickFlag(p, 'transparent-color');
  const targetToleranceStr = pickFlag(p, 'target-tolerance');
  const transparentToleranceStr = pickFlag(p, 'transparent-tolerance');
  const paddingStr = pickFlag(p, 'padding');

  // --no-transparent 显式关闭颜色透明化（传 null）
  const noTransparent = pickBool(p, 'no-transparent');
  const transparentColor = noTransparent
    ? null
    : (transparentColorStr !== undefined ? parseRGB(transparentColorStr, 'transparent-color') : undefined);

  return {
    sourceImgPath: src,
    outputPath,
    keepRegion,
    targetColor: targetColorStr !== undefined ? parseRGB(targetColorStr, 'target-color') : undefined,
    targetTolerance: targetToleranceStr !== undefined ? Number(targetToleranceStr) : undefined,
    transparentColor,
    transparentTolerance: transparentToleranceStr !== undefined ? Number(transparentToleranceStr) : undefined,
    padding: paddingStr !== undefined ? Number(paddingStr) : undefined,
    encodeOptions,
  };
}

async function runStamp(p: ParsedArgs): Promise<void> {
  if (pickBool(p, 'h', 'help')) { printStampHelp(); return; }

  const bg = pickFlag(p, 'bg', 'background');
  const text = pickFlag(p, 'text');
  if (!bg) throw new Error('缺少必填参数 --bg <path>');
  if (!text) throw new Error('缺少必填参数 --text <string>');
  if (text.length < 1 || text.length > 255) throw new Error(`--text 长度需在 1-255 之间，实际 ${text.length}`);
  if (!fs.existsSync(bg)) throw new Error(`背景图不存在: ${bg}`);

  const format = (pickFlag(p, 'format') ?? 'png') as EncodeFormat;
  const out = pickFlag(p, 'out', 'output') ?? path.join('out', `stamp${getExtForFormat(format)}`);
  const qualityStr = pickFlag(p, 'quality');
  const encodeOptions: EncodeFormat | EncodeOptions = qualityStr !== undefined
    ? { format, quality: Number(qualityStr) }
    : format;

  const stampOpts = buildStampOptions(p, bg, text, encodeOptions);
  const buffer = await generateDynamicStamp(stampOpts);

  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, buffer);
  const tr = stampOpts.textRegion;
  const regionInfo = tr ? ` region=${tr.x},${tr.y},${tr.width}x${tr.height} stretch=${stampOpts.stretchTextRegion ?? true}` : '';
  const speckleInfo = stampOpts.speckleMode === 'none' ? ' speckle=off' : ` speckle=${stampOpts.speckleMode ?? 'per-char'}`;
  console.log(`已生成印章: ${path.resolve(out)} (${buffer.length} bytes)${regionInfo}${speckleInfo}`);
}

async function runCrop(p: ParsedArgs): Promise<void> {
  if (pickBool(p, 'h', 'help')) { printCropHelp(); return; }

  const src = pickFlag(p, 'src', 'source');
  if (!src) throw new Error('缺少必填参数 --src <path>');
  if (!fs.existsSync(src)) throw new Error(`源图不存在: ${src}`);

  const format = (pickFlag(p, 'format') ?? 'png') as EncodeFormat;
  const out = pickFlag(p, 'out', 'output') ?? path.join('out', `clean-bg${getExtForFormat(format)}`);

  const qualityStr = pickFlag(p, 'quality');
  const encodeOptions: EncodeFormat | EncodeOptions = qualityStr !== undefined
    ? { format, quality: Number(qualityStr) }
    : format;

  const cropOpts = buildCropOptions(p, src, out, encodeOptions);
  const result = await cropTransparentBackground(cropOpts);

  const r = result.region;
  console.log(`已生成底图: ${path.resolve(out)} (${result.buffer.length} bytes, keep=${cropOpts.keepRegion ?? 'outside'})`);
  console.log(`  画布: ${result.width}x${result.height}`);
  console.log(`  region: x=${r.x} y=${r.y} w=${r.width} h=${r.height}`);
  console.log(`  作为 stamp --text-region 参数: "${r.x},${r.y},${r.width},${r.height}"`);
}

/**
 * gen 子命令：端到端流水线
 *   crop(src)  buffer + region  写入临时/指定中间文件
 *    stamp(中间文件, text, textRegion=region)  写入 --out
 *
 * 中间文件策略：
 *   - 用户传 --intermediate <path>：落到该路径并保留
 *   - 用户传 --keep-intermediate（无路径）：在 out 目录生成 gen-crop-<rand>.png 并保留
 *   - 默认：os.tmpdir() 下生成临时 PNG，stamp 结束后立即删除
 */
async function runGen(p: ParsedArgs): Promise<void> {
  if (pickBool(p, 'h', 'help')) { printGenHelp(); return; }

  const src = pickFlag(p, 'src', 'source');
  const text = pickFlag(p, 'text');
  if (!src) throw new Error('缺少必填参数 --src <path>');
  if (!text) throw new Error('缺少必填参数 --text <string>');
  if (text.length < 1 || text.length > 255) throw new Error(`--text 长度需在 1-255 之间，实际 ${text.length}`);
  if (!fs.existsSync(src)) throw new Error(`源图不存在: ${src}`);

  const format = (pickFlag(p, 'format') ?? 'png') as EncodeFormat;
  const out = pickFlag(p, 'out', 'output') ?? path.join('out', `gen-stamp${getExtForFormat(format)}`);
  const qualityStr = pickFlag(p, 'quality');
  const encodeOptions: EncodeFormat | EncodeOptions = qualityStr !== undefined
    ? { format, quality: Number(qualityStr) }
    : format;

  // 决定中间文件路径与是否保留
  const intermediateFlag = pickFlag(p, 'intermediate');
  const keepIntermediate = pickBool(p, 'keep-intermediate');
  let intermediatePath: string;
  let shouldKeepIntermediate: boolean;
  if (intermediateFlag !== undefined) {
    intermediatePath = intermediateFlag;
    shouldKeepIntermediate = true;
  } else if (keepIntermediate) {
    intermediatePath = path.join('out', `gen-crop-${Date.now()}.png`);
    shouldKeepIntermediate = true;
  } else {
    // 临时文件：放在系统 tmp，确保 stamp 读取后能立即清理
    intermediatePath = path.join(os.tmpdir(), `image-lib-gen-${process.pid}-${Date.now()}.png`);
    shouldKeepIntermediate = false;
  }

  // ——  1. 抠图 ——
  // 中间产物固定用 PNG（保留透明度，避免 jpeg 把抠透区域填白）
  const cropOpts = buildCropOptions(p, src, intermediatePath, 'png');
  const cropResult = await cropTransparentBackground(cropOpts);
  const r = cropResult.region;

  // —— 印章（textRegion 直接复用 crop 返回的 region） ——
  const stampOpts = buildStampOptions(p, intermediatePath, text, encodeOptions, r);

  // —— gen 专属默认（仅在用户未显式指定时生效） ——
  // - fontFamily 不再硬塞 'sans-serif' —— Skia 不做 per-glyph 回退,'sans-serif'
  //   会映射到 Latin 字体导致中文渲染豆腐块。改为 undefined,让 loadFont 根据
  //   文本内容(含 CJK?)智能挑选已注册的单一字体名(平台 CJK 字体 / Latin 字体)
  // - fontSize 默认 24pt = 32px(96 DPI 下 24 × 4/3 = 32)
  if (stampOpts.fontSize === undefined) {
    stampOpts.fontSize = Math.round(24 * 96 / 72); // 24pt → 32px
  }

  const stampBuf = await generateDynamicStamp(stampOpts);

  // ——  3. 写最终输出 ——
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, stampBuf);

  // ——  4. 清理临时中间产物 ——
  if (!shouldKeepIntermediate) {
    try { fs.unlinkSync(intermediatePath); } catch { /* 忽略：失败也不影响主流程 */ }
  }

  const speckleInfo = stampOpts.speckleMode === 'none' ? ' speckle=off' : ` speckle=${stampOpts.speckleMode ?? 'per-char'}`;
  const intInfo = shouldKeepIntermediate ? ` intermediate=${path.resolve(intermediatePath)}` : '';
  const fontInfo = `${stampOpts.fontFamily ?? '(custom)'} ${stampOpts.fontSize}px`;
  console.log(`已生成印章: ${path.resolve(out)} (${stampBuf.length} bytes)`);
  console.log(`  画布: ${cropResult.width}x${cropResult.height}  keep=${cropOpts.keepRegion ?? 'outside'}`);
  console.log(`  font: ${fontInfo}`);
  console.log(`  textRegion: x=${r.x} y=${r.y} w=${r.width} h=${r.height}${speckleInfo}${intInfo}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) { printRootHelp(); return; }

  const parsed = parseArgs(argv);
  const cmd = parsed._[0];

  if (pickBool(parsed, 'v', 'version')) { console.log(VERSION); return; }
  if (!cmd && pickBool(parsed, 'h', 'help')) { printRootHelp(); return; }

  // 把子命令位置参从 _ 中移除
  const subArgs: ParsedArgs = { _: parsed._.slice(1), flags: parsed.flags };

  switch (cmd) {
    case 'stamp': return runStamp(subArgs);
    case 'crop':  return runCrop(subArgs);
    case 'gen':   return runGen(subArgs);
    case 'help':
    case undefined: return printRootHelp();
    default:
      console.error(`未知命令: ${cmd}`);
      printRootHelp();
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(` ${msg}`);
  process.exit(1);
});