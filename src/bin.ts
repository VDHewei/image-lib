#!/usr/bin/env bun
/**
 * image_lib CLI
 *
 * 子命令：
 *   stamp  生成动态印章图片（支持中英文、自定义字体/字号/颜色）
 *   crop   抠图：从源图提取边框，生成中间透明的"无字底图"
 *
 * 通用 flags：
 *   -h, --help     显示帮助
 *   -v, --version  显示版本号
 *
 * 详细 flags 见 `bun src/bin.ts <subcommand> --help`
 */
import path from 'path';
import fs from 'fs';
import {
  generateDynamicStamp,
  cropTransparentBackground,
  getExtForFormat,
  type EncodeFormat,
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

GLOBAL OPTIONS:
  -h, --help     显示帮助
  -v, --version  显示版本

EXAMPLES:
  image-lib stamp --bg images/draft.png --text "草稿" --out out/stamp.png
  image-lib crop  --src images/draft.png --out out/clean-bg.png
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
  --font-family <css>         系统字体族（默认跨平台后备）
  --font-name <name>          注册到 GlobalFonts 的字体名
  --font-size <px>            字号（默认 40）
  --font-color <#hex>         字体颜色（默认 #FF99A8）
  --no-bold                   关闭加粗

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
  const encodeOptions = qualityStr !== undefined
    ? { format, quality: Number(qualityStr) }
    : format;

  const fontSizeStr = pickFlag(p, 'font-size');

  // —— textRegion / 拉伸策略 ——
  const textRegionStr = pickFlag(p, 'text-region');
  const textRegion = textRegionStr !== undefined ? parseRegion(textRegionStr, 'text-region') : undefined;
  const noStretch = pickBool(p, 'no-stretch');
  const overflowRaw = pickFlag(p, 'overflow');
  if (overflowRaw !== undefined && !['shrink', 'clip', 'overflow'].includes(overflowRaw)) {
    throw new Error(`--overflow 必须是 'shrink' | 'clip' | 'overflow'，实际 "${overflowRaw}"`);
  }
  const overflowStrategy = overflowRaw as ('shrink' | 'clip' | 'overflow' | undefined);

  const buffer = await generateDynamicStamp({
    backgroundPath: bg,
    text,
    fontURL: pickFlag(p, 'font-url'),
    fontFilePath: pickFlag(p, 'font-file'),
    fontFamily: pickFlag(p, 'font-family'),
    fontName: pickFlag(p, 'font-name'),
    fontSize: fontSizeStr !== undefined ? Number(fontSizeStr) : undefined,
    fontColor: pickFlag(p, 'font-color'),
    fontBold: !pickBool(p, 'no-bold'),
    margin: parseMargin(p),
    encodeOptions,
    textRegion,
    stretchTextRegion: textRegion ? !noStretch : undefined,
    overflowStrategy,
  });

  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, buffer);
  const regionInfo = textRegion ? ` region=${textRegion.x},${textRegion.y},${textRegion.width}x${textRegion.height} stretch=${!noStretch}` : '';
  console.log(`已生成印章: ${path.resolve(out)} (${buffer.length} bytes)${regionInfo}`);
}

async function runCrop(p: ParsedArgs): Promise<void> {
  if (pickBool(p, 'h', 'help')) { printCropHelp(); return; }

  const src = pickFlag(p, 'src', 'source');
  if (!src) throw new Error('缺少必填参数 --src <path>');
  if (!fs.existsSync(src)) throw new Error(`源图不存在: ${src}`);

  const format = (pickFlag(p, 'format') ?? 'png') as EncodeFormat;
  const out = pickFlag(p, 'out', 'output') ?? path.join('out', `clean-bg${getExtForFormat(format)}`);

  const qualityStr = pickFlag(p, 'quality');
  const encodeOptions = qualityStr !== undefined
    ? { format, quality: Number(qualityStr) }
    : format;

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

  const result = await cropTransparentBackground({
    sourceImgPath: src,
    outputPath: out,
    keepRegion,
    targetColor: targetColorStr !== undefined ? parseRGB(targetColorStr, 'target-color') : undefined,
    targetTolerance: targetToleranceStr !== undefined ? Number(targetToleranceStr) : undefined,
    transparentColor,
    transparentTolerance: transparentToleranceStr !== undefined ? Number(transparentToleranceStr) : undefined,
    padding: paddingStr !== undefined ? Number(paddingStr) : undefined,
    encodeOptions,
  });

  const r = result.region;
  console.log(`已生成底图: ${path.resolve(out)} (${result.buffer.length} bytes, keep=${keepRegion ?? 'outside'})`);
  console.log(`  画布: ${result.width}x${result.height}`);
  console.log(`  region: x=${r.x} y=${r.y} w=${r.width} h=${r.height}`);
  console.log(`  作为 stamp --text-region 参数: "${r.x},${r.y},${r.width},${r.height}"`);
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