import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import type { Canvas, AvifConfig } from '@napi-rs/canvas';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';

/** 支持的图片导出格式，与 @napi-rs/canvas 的 encode 重载严格对齐 */
export type EncodeFormat = 'png' | 'jpeg' | 'webp' | 'avif' | 'gif';

/**
 * 图片导出选项
 * - 简写：直接传 EncodeFormat 字符串，使用各格式默认参数
 * - 完整：传对象，可指定 quality（jpeg/webp/gif）或 avifConfig（avif）
 */
export interface EncodeOptions {
  format?: EncodeFormat;       // 默认 'png'
  quality?: number;            // jpeg/webp/gif 通用质量参数（0-100 整数）
  avifConfig?: AvifConfig;     // 仅 format='avif' 时生效
}

/**
 * 文本超出 textRegion 宽度时的处理策略（仅 stretchTextRegion=false 时生效）：
 * - 'shrink'   ：自动缩小字号到适配（保持完整可读，**默认**）
 * - 'clip'     ：保持字号绘制，将文字裁剪到 region 矩形内（超出部分丢弃）
 * - 'overflow' ：保持字号绘制，允许文字溢出 region（不做裁剪）
 */
export type OverflowStrategy = 'shrink' | 'clip' | 'overflow';

/** 文字填充矩形（绝对像素坐标，相对背景图） */
export interface TextRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GenerateStampOptions {
  backgroundPath: string; // 基础背景图路径
  text: string;           // 动态输入的文字
  fontSize?: number;      // 字体大小，默认 40
  fontFamily?: string;    // 系统字体名称，默认 'Arial' 或 'sans-serif'
  fontURL?: string;       // 可选的在线字体文件 URL（如 Google Fonts），优先级最高
  fontFilePath?: string;  // 可选的本地字体文件路径（.ttf/.otf/.woff/.woff2 等），优先级仅次于 fontURL
  fontName?: string;      // 在线字体注册时使用的字体名称，默认为 'StampFont'
  fontBold?: boolean;     // 是否加粗，默认 true
  fontColor?: string;     // 字体颜色，默认粉色 '#FF99A8'
  margin?: { top: number; right: number; bottom: number; left: number }; // 上右下左边距
  encodeOptions?: EncodeFormat | EncodeOptions; // 导出编码选项：可传 format 字符串或完整对象

  /**
   * 文字填充矩形（绝对像素坐标，相对背景图）。通常配合 `cropTransparentBackground` 的
   * `region` 输出使用，让文字精确落在抠除的"洞"里。
   * - 不指定：保持原行为（按文本宽度自适应整张画布，三段拉伸+居中）
   * - 指定  ：文字绘制在该矩形中央（水平/垂直居中），背景图保持原尺寸
   */
  textRegion?: TextRegion;

  /**
   * 文字宽度超出 `textRegion` 时是否水平拉伸 region 及画布，默认 `true`。
   * - `true` ：把 region 水平拉宽到容纳完整文本，region 左右两侧背景原样保留（三段拉伸）
   * - `false`：保持画布尺寸，按 `overflowStrategy` 处理超长文本
   * 仅 `textRegion` 存在时生效。
   */
  stretchTextRegion?: boolean;

  /**
   * 当 `stretchTextRegion=false` 且文本超出 region 宽度时的策略，默认 `'shrink'`
   * 仅 `textRegion` 存在且 `stretchTextRegion=false` 时生效。
   */
  overflowStrategy?: OverflowStrategy;
}

export interface FontCacheEntry {
    url?: string;    // 字体文件的来源 URL
    fontName: string; // 注册到 GlobalFonts 的字体名称
    rootPath?: string; // 字体文件在项目中的存储路径
}


/**
 * 加载字体的辅助函数，支持在线字体和本地字体文件
 * - 在线字体：通过 URL 加载并注册到 GlobalFonts，适合在生产环境使用 CDN 字体资源
 * - 本地字体：从项目内的 fonts 目录加载，适合开发环境快速测试（请确保字体文件存在）
 * - 字体回退：如果两者都未提供或加载失败，使用系统默认字体族（如 'Arial, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'）以保证兼容性
 */
export async function downloadFont(url: string, outputPath: string): Promise<Buffer> {
    // cache 机制：如果字体文件已存在且大小大于 0，则跳过下载
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0 && fs.existsSync(outputPath+'.url')) {
        const cacheURL = await fs.promises.readFile(outputPath+'.url', 'utf-8');
        if (cacheURL === url) {
            console.log(`Font already exists at ${outputPath}, skipping download.`);
           return await fs.promises.readFile(outputPath);
        }
    }
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to download font from ${url}: ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    await fs.promises.writeFile(outputPath, Buffer.from(arrayBuffer));
    // 记录下载来源 URL 以便后续维护
    await fs.promises.writeFile(outputPath+'.url', url);
    return Buffer.from(arrayBuffer);
}

/**
 * 解析字体缓存路径，基于字体名称和 URL 生成唯一的缓存文件名，存储在项目的 font_cache 目录下
 * @param options - 字体加载选项，包含在线字体 URL 和字体名称
 * @returns 
 */
// 字体扩展名白名单：保证只接受已知字体格式，未知格式回退到默认值
export const VALID_FONT_EXTS = new Set(['.ttf', '.otf', '.woff', '.woff2', '.ttc', '.eot']);
export const DEFAULT_FONT_EXT = '.otf';
// 多数文件系统单段上限 255 字节，留些余量给后缀拼接
const MAX_FILENAME_LEN = 120;

/**
 * 从 URL 中安全提取字体扩展名
 * - 优先用 URL 解析，去除 query/hash
 * - 通过白名单校验，未知扩展名统一回落到 DEFAULT_FONT_EXT
 * - 处理边界：相对路径、缺失协议头时退化为字符串切分
 */
function extractExtFromUrl(rawUrl: string): string {
    let pathname = rawUrl;
    try {
        pathname = new URL(rawUrl).pathname;
    } catch {
        // URL 不合法时，手动剥离 query/hash（兼容 noUncheckedIndexedAccess）
        const noHash = rawUrl.split('#')[0] ?? rawUrl;
        pathname = noHash.split('?')[0] ?? noHash;
    }
    const ext = path.extname(pathname).toLowerCase();
    return VALID_FONT_EXTS.has(ext) ? ext : DEFAULT_FONT_EXT;
}

/**
 * 把任意 fontName 规范化为跨平台安全的文件名片段
 * - 去除已有字体扩展名，避免重复后缀
 * - 仅保留 [a-z0-9_-]，其他字符替换为 _
 * - 合并连续下划线并 trim，避免出现 "__" 或首尾下划线
 * - 空字符串兜底为 "font"
 */
function sanitizeFontName(name: string): string {
    if (!name || typeof name !== 'string') {
        throw new TypeError('resolveFontCachePath: fontName must be a non-empty string');
    }
    const withoutExt = name.replace(/\.(ttf|otf|woff2?|ttc|eot)$/i, '');
    const safe = withoutExt
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toLowerCase();
    return safe || 'font';
}

/**
 * 对 URL 取 SHA-1 hex 短哈希，作为缓存文件名后缀
 * - 文件名安全（纯 hex），无 base64 中的 / + = 等非法字符
 * - 10 位 hex ≈ 40bit，碰撞概率对单项目缓存场景可忽略
 */
function hashUrl(url: string, length = 10): string {
    return crypto.createHash('sha1').update(url).digest('hex').slice(0, length);
}

/**
 * 系统受保护目录黑名单（跨平台）
 * - 命中这些目录或其子路径会被拒绝写入，防止误删/越权写入系统文件
 * - Windows 区分大小写不敏感，统一以小写形式比较
 */
const FORBIDDEN_DIR_PREFIXES: readonly string[] = process.platform === 'win32'
    ? [
        'C:\\Windows',
        'C:\\Program Files',
        'C:\\Program Files (x86)',
        'C:\\ProgramData',
        'C:\\System Volume Information',
        'C:\\Boot',
        'C:\\Recovery',
        'C:\\$Recycle.Bin',
    ]
    : [
        '/etc', '/usr', '/bin', '/sbin', '/boot', '/dev',
        '/proc', '/sys', '/root', '/var', '/opt',
        '/System', '/Library', '/private',
    ];

/**
 * 沙箱白名单：rootPath 必须落在以下根目录之下
 * - 进程工作目录、模块所在目录：覆盖常规项目使用场景
 * - 系统临时目录：兼容容器/Serverless 场景
 * - 环境变量 FONT_CACHE_ALLOWED_ROOTS：调用方显式授权扩展（多路径用 path.delimiter 分隔）
 */
function getAllowedRoots(): string[] {
    const roots = new Set<string>();
    roots.add(path.resolve(process.cwd()));
    roots.add(path.resolve(__dirname));
    roots.add(path.resolve(os.tmpdir()));
    const extra = process.env.FONT_CACHE_ALLOWED_ROOTS;
    if (extra) {
        for (const p of extra.split(path.delimiter)) {
            const trimmed = p.trim();
            if (trimmed) roots.add(path.resolve(trimmed));
        }
    }
    return [...roots];
}

/**
 * 跨平台路径归一化：Windows 大小写不敏感，统一小写比较
 */
function normalizeForCompare(p: string): string {
    return process.platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * 判断 child 是否在 parent 路径之下（包含相等情况）
 * 利用 path.relative 自动处理 ..、分隔符差异
 */
function isPathInside(child: string, parent: string): boolean {
    const rel = path.relative(parent, child);
    if (rel === '') return true; // 路径相等
    // 不以 .. 开头、不是绝对路径 → 在 parent 之下
    return !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel);
}

/**
 * 校验 rootPath 的安全性，防止越权写入系统受保护目录
 * - 校验失败抛错，调用方需显式处理（不静默回退到默认目录，避免误导）
 * @throws {Error} 当路径越界、命中黑名单或为根目录时
 */
function assertSafeRootPath(rawRootPath: string): string {
    if (typeof rawRootPath !== 'string' || !rawRootPath.trim()) {
        throw new Error('resolveFontCachePath: rootPath 必须是非空字符串');
    }
    const resolved = path.resolve(rawRootPath);

    // ① 拒绝文件系统根目录（/、C:\、D:\ 等）
    const parsed = path.parse(resolved);
    if (resolved === parsed.root) {
        throw new Error(`resolveFontCachePath: rootPath "${rawRootPath}" 不能是文件系统根目录`);
    }

    // ② 白名单校验：必须位于允许的沙箱根目录之下
    const allowedRoots = getAllowedRoots();
    const matchedRoot = allowedRoots.find(root => isPathInside(resolved, root));
    if (!matchedRoot) {
        throw new Error(
            `resolveFontCachePath: rootPath "${rawRootPath}" 越界，未落入允许的沙箱目录。\n` +
            `允许的根目录: ${allowedRoots.join(', ')}\n` +
            `如需扩展，请通过环境变量 FONT_CACHE_ALLOWED_ROOTS 配置（多个用 "${path.delimiter}" 分隔）。`
        );
    }

    // ③ 黑名单兜底：即使命中白名单，也要禁止系统受保护目录
    //    例外：若 matchedRoot 本身就位于某个 forbidden 之下（如 macOS tmpdir=/var/folders/...），
    //    说明该 forbidden 已被合法白名单覆盖，放行 matchedRoot 之下的子路径
    const cmpResolved = normalizeForCompare(resolved);
    const cmpMatchedRoot = normalizeForCompare(matchedRoot);
    for (const forbidden of FORBIDDEN_DIR_PREFIXES) {
        const cmpForbidden = normalizeForCompare(forbidden);
        const hitForbidden =
            cmpResolved === cmpForbidden || cmpResolved.startsWith(cmpForbidden + path.sep);
        if (!hitForbidden) continue;

        // 例外规则：白名单 root 已落在 forbidden 之下，视为已授权
        const rootInForbidden =
            cmpMatchedRoot === cmpForbidden || cmpMatchedRoot.startsWith(cmpForbidden + path.sep);
        if (rootInForbidden) continue;

        throw new Error(
            `resolveFontCachePath: rootPath "${rawRootPath}" 命中系统受保护目录 "${forbidden}"，拒绝创建`
        );
    }

    return resolved;
}

/**
 * 解析字体缓存路径，基于字体名称和 URL 生成唯一的缓存文件名，存储在项目的 font_cache 目录下
 * @param options - 加载字体的选项，支持在线字体 URL 和本地字体文件路径
 * @returns 
 */
export function resolveFontCachePath(options: FontCacheEntry): string {
    // 缓存目录：显式传入 rootPath（即使是 ""）都走安全校验，避免把 bug 误判为"使用默认"
    const cacheDir = options.rootPath !== undefined
        ? assertSafeRootPath(options.rootPath)
        : path.join(__dirname, 'font_cache');
    // recursive 兼顾多级目录场景，且目录已存在时不会抛错
    fs.mkdirSync(cacheDir, { recursive: true });

    const safeFontName = sanitizeFontName(options.fontName);

    let fileName: string;
    if (options.url) {
        // URL 字体：附带 hash 防止同 fontName 不同 URL 互相覆盖
        const ext = extractExtFromUrl(options.url);
        const hash = hashUrl(options.url);
        fileName = `${safeFontName}_${hash}${ext}`;
    } else {
        // 本地字体：仅用规范化后的字体名 + 默认扩展名
        fileName = `${safeFontName}${DEFAULT_FONT_EXT}`;
    }

    // 文件名长度兜底，保留扩展名，截断主体部分
    if (fileName.length > MAX_FILENAME_LEN) {
        const ext = path.extname(fileName);
        fileName = fileName.slice(0, MAX_FILENAME_LEN - ext.length) + ext;
    }

    return path.join(cacheDir, fileName);
}

/**
 * 字体加载器，按优先级尝试以下三种方式，命中即返回可用字体族名：
 *
 * 1. **远程字体（fontURL）**：从 URL 下载，写入 `font_cache/`，再 `GlobalFonts.register`。
 *    适合 CDN 字体（如 Google Fonts 直链 .ttf/.woff2），含本地磁盘缓存避免重复下载。
 * 2. **本地字体文件（fontFilePath）**：直接 `GlobalFonts.registerFromPath`，
 *    适合开发环境或私有字体（思源黑体、自定义品牌字体等）。
 * 3. **系统字体族（fontFamily）**：直接返回 CSS font-family 字符串，
 *    由 @napi-rs/canvas 在 Skia 层走系统字体回退（Linux 需安装 fontconfig）。
 *
 * 任意一步失败都会回退到下一步，最终兜底返回跨平台后备字体族，确保渲染不出豆腐块。
 */
export async function loadFont(options: GenerateStampOptions): Promise<string> {
  // —— ① 远程字体优先 ——
  if (options.fontURL) {
    const fontName = options.fontName || 'StampFont';
    if (GlobalFonts.has(fontName)) return fontName;
    try {
      const cachePath = resolveFontCachePath({ url: options.fontURL, fontName });
      const buffer = await downloadFont(options.fontURL, cachePath);
      GlobalFonts.register(buffer, fontName);
      return fontName;
    } catch (e) {
      console.warn(`[loadFont] 远程字体加载失败，将尝试下一级回退: ${(e as Error).message}`);
    }
  }

  // —— ② 本地字体文件 ——
  if (options.fontFilePath) {
    const fontName = options.fontName || path.basename(options.fontFilePath, path.extname(options.fontFilePath));
    if (GlobalFonts.has(fontName)) return fontName;
    if (fs.existsSync(options.fontFilePath) && fs.statSync(options.fontFilePath).size > 0) {
      try {
        GlobalFonts.registerFromPath(options.fontFilePath, fontName);
        return fontName;
      } catch (e) {
        console.warn(`[loadFont] 本地字体注册失败，将尝试下一级回退: ${(e as Error).message}`);
      }
    } else {
      console.warn(`[loadFont] 本地字体文件不存在或为空: ${options.fontFilePath}`);
    }
  }

  // —— ③ 系统字体族（CSS font-family 字符串） ——
  return options.fontFamily || 'Arial, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
}

/**
 * 支持的编码格式集合，与 @napi-rs/canvas 重载严格对齐
 */
const VALID_ENCODE_FORMATS = new Set<EncodeFormat>(['png', 'jpeg', 'webp', 'avif', 'gif']);
/** format → MIME 映射 */
const FORMAT_MIME: Record<EncodeFormat, string> = {
    png: 'image/png',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    avif: 'image/avif',
    gif: 'image/gif',
};
/** format → 默认扩展名（含 .） */
const FORMAT_EXT: Record<EncodeFormat, string> = {
    png: '.png',
    jpeg: '.jpg',
    webp: '.webp',
    avif: '.avif',
    gif: '.gif',
};

/** 根据 format 取 MIME，便于调用方写 HTTP Content-Type */
export function getMimeForFormat(format: EncodeFormat): string {
    return FORMAT_MIME[format];
}

/** 根据 format 取建议扩展名（含 .），便于调用方落盘命名 */
export function getExtForFormat(format: EncodeFormat): string {
    return FORMAT_EXT[format];
}

/**
 * 把宽松的 encodeOptions（字符串/对象/undefined）规范化为严格对象
 * - format 白名单校验，不支持的格式直接抛错
 * - quality 范围校验（0-100 数字），用错格式时打 warn 但不抛
 * - avifConfig 仅 format='avif' 时生效
 * @throws {TypeError|RangeError|Error} 校验失败
 */
export function normalizeEncodeOptions(
    input?: EncodeFormat | EncodeOptions,
): Required<Pick<EncodeOptions, 'format'>> & EncodeOptions {
    // 1) 归一为对象形式
    let opts: EncodeOptions;
    if (input === undefined || input === null) {
        opts = {};
    } else if (typeof input === 'string') {
        opts = { format: input };
    } else if (typeof input === 'object') {
        opts = input;
    } else {
        throw new TypeError(`encodeOptions: 不支持的类型 "${typeof input}"，应为字符串或对象`);
    }

    // 2) format 默认值 + 白名单校验
    const format = (opts.format ?? 'png') as EncodeFormat;
    if (!VALID_ENCODE_FORMATS.has(format)) {
        throw new Error(
            `encodeOptions.format "${format}" 不支持，可选值: ${[...VALID_ENCODE_FORMATS].join(', ')}`
        );
    }

    // 3) quality 校验
    if (opts.quality !== undefined) {
        const q = opts.quality;
        if (typeof q !== 'number' || !Number.isFinite(q) || q < 0 || q > 100) {
            throw new RangeError(`encodeOptions.quality 必须是 0-100 的有限数字，实际收到 ${q}`);
        }
        if (format === 'png' || format === 'avif') {
            console.warn(
                `[encodeOptions] format="${format}" 不接受 quality 参数，将被忽略。` +
                (format === 'avif' ? ' AVIF 请改用 avifConfig.quality。' : '')
            );
        }
    }

    // 4) avifConfig 仅 avif 生效
    if (opts.avifConfig && format !== 'avif') {
        console.warn(`[encodeOptions] avifConfig 仅在 format="avif" 时生效，已忽略`);
    }

    return { ...opts, format };
}

/**
 * 统一调度 canvas.encode 的各重载
 * - 按 @napi-rs/canvas 实际签名分发，规避 TS 重载推断失败
 * - 集中此处便于将来扩展（如统一 hook、metric 上报）
 */
export async function encodeCanvas(
    canvas: Canvas,
    input?: EncodeFormat | EncodeOptions,
): Promise<Buffer> {
    const { format, quality, avifConfig } = normalizeEncodeOptions(input);
    switch (format) {
        case 'png':
            return canvas.encode('png');
        case 'jpeg':
        case 'webp':
            return quality !== undefined
                ? canvas.encode(format, quality)
                : canvas.encode(format);
        case 'gif':
            return quality !== undefined
                ? canvas.encode('gif', quality)
                : canvas.encode('gif');
        case 'avif':
            return avifConfig
                ? canvas.encode('avif', avifConfig)
                : canvas.encode('avif');
    }
}

/**
 * 动态生成自适应文本长度的印章图片（支持系统字体）
 *
 * 两种模式：
 *
 * **A. 无 textRegion（原行为）**
 *   按文本宽度自适应整张画布，三段水平拉伸保留头尾，文字居中。
 *
 * **B. 有 textRegion（新增）**
 *   把文字精确画到指定矩形里，矩形通常来自 `cropTransparentBackground` 的 `region` 返回值：
 *   - 文本不超长：画布保持背景图原尺寸，文字在 region 中心绘制
 *   - 文本超长 + `stretchTextRegion=true`（默认）：水平拉伸画布与 region，左右背景原样保留
 *   - 文本超长 + `stretchTextRegion=false`：按 `overflowStrategy` 处理
 *       - `shrink` (默认): 二分缩小字号到适配
 *       - `clip`         : 保持字号，裁剪到 region 内
 *       - `overflow`     : 保持字号，允许溢出
 */
export async function generateDynamicStamp(options: GenerateStampOptions): Promise<Buffer> {
  const text = options.text;
  const fontSize = options.fontSize || 40;
  const isBold = options.fontBold !== false ? 'bold ' : '';

  // 1. 字体加载与样式构造
  const fontFamily = await loadFont(options);
  const buildFontStyle = (size: number) => `${isBold}${size}px ${fontFamily}`;

  const fontColor = options.fontColor || '#FF99A8';
  const margin = options.margin || { top: 20, right: 20, bottom: 20, left: 20 };
  const stretchTextRegion = options.stretchTextRegion !== false; // 默认 true
  const overflowStrategy: OverflowStrategy = options.overflowStrategy || 'shrink';

  // 2. 加载背景图
  const bgImage = await loadImage(options.backgroundPath);
  const bgWidth = bgImage.width;
  const bgHeight = bgImage.height;

  // 3. 虚拟画布测量文本
  const measureCanvas = createCanvas(1, 1);
  const measureCtx = measureCanvas.getContext('2d');
  measureCtx.font = buildFontStyle(fontSize);
  const textRealWidth = Math.ceil(measureCtx.measureText(text).width);
  const textRealHeight = fontSize;

  //  路径 B：指定了 textRegion 
  if (options.textRegion) {
    return await renderStampInRegion({
      bgImage,
      bgWidth,
      bgHeight,
      text,
      textRegion: options.textRegion,
      fontSize,
      textRealWidth,
      textRealHeight,
      margin,
      stretchTextRegion,
      overflowStrategy,
      buildFontStyle,
      fontColor,
      measureCtx,
      encodeOptions: options.encodeOptions,
    });
  }

  //  路径 A：无 textRegion，保持原行为 
  const finalCanvasWidth = margin.left + textRealWidth + margin.right;
  const finalCanvasHeight = margin.top + textRealHeight + margin.bottom;

  const canvas = createCanvas(finalCanvasWidth, finalCanvasHeight);
  const ctx = canvas.getContext('2d');

  // 三段式无损拉伸：左右各取 15% 宽度，中间拉伸适配
  const cutWidth = Math.floor(bgWidth * 0.15);
  const midWidth = bgWidth - (cutWidth * 2);

  ctx.drawImage(bgImage, 0, 0, cutWidth, bgHeight, 0, 0, cutWidth, finalCanvasHeight);
  const targetMidWidth = finalCanvasWidth - (cutWidth * 2);
  if (targetMidWidth > 0) {
    ctx.drawImage(bgImage, cutWidth, 0, midWidth, bgHeight, cutWidth, 0, targetMidWidth, finalCanvasHeight);
  }
  ctx.drawImage(bgImage, bgWidth - cutWidth, 0, cutWidth, bgHeight, finalCanvasWidth - cutWidth, 0, cutWidth, finalCanvasHeight);

  ctx.font = buildFontStyle(fontSize);
  ctx.fillStyle = fontColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, finalCanvasWidth / 2, finalCanvasHeight / 2);

  return await encodeCanvas(canvas, options.encodeOptions);
}

//  内部辅助：textRegion 模式渲染 

interface RenderInRegionParams {
  bgImage: Awaited<ReturnType<typeof loadImage>>;
  bgWidth: number;
  bgHeight: number;
  text: string;
  textRegion: TextRegion;
  fontSize: number;
  textRealWidth: number;
  textRealHeight: number;
  margin: { top: number; right: number; bottom: number; left: number };
  stretchTextRegion: boolean;
  overflowStrategy: OverflowStrategy;
  buildFontStyle: (size: number) => string;
  fontColor: string;
  measureCtx: ReturnType<ReturnType<typeof createCanvas>['getContext']>;
  encodeOptions?: EncodeFormat | EncodeOptions;
}

async function renderStampInRegion(p: RenderInRegionParams): Promise<Buffer> {
  const {
    bgImage, bgWidth, bgHeight,
    text, textRegion, fontSize, textRealWidth, textRealHeight,
    margin, stretchTextRegion, overflowStrategy,
    buildFontStyle, fontColor, measureCtx, encodeOptions,
  } = p;

  // ── 校验 textRegion ──
  if (!Number.isFinite(textRegion.x) || !Number.isFinite(textRegion.y)
   || !Number.isFinite(textRegion.width) || !Number.isFinite(textRegion.height)) {
    throw new TypeError('textRegion 的 x/y/width/height 必须都是有限数');
  }
  if (textRegion.width <= 0 || textRegion.height <= 0) {
    throw new RangeError(`textRegion.width/height 必须 > 0，实际 ${textRegion.width}×${textRegion.height}`);
  }
  if (textRegion.x < 0 || textRegion.y < 0) {
    throw new RangeError(`textRegion.x/y 必须 ≥ 0，实际 (${textRegion.x}, ${textRegion.y})`);
  }
  if (textRegion.x + textRegion.width > bgWidth || textRegion.y + textRegion.height > bgHeight) {
    throw new RangeError(
      `textRegion (${textRegion.x},${textRegion.y},${textRegion.width}×${textRegion.height}) ` +
      `超出背景图 ${bgWidth}×${bgHeight}`
    );
  }

  // region 内可用绘制宽度 = region.width - 左右 margin（至少 1px 兜底）
  const usableWidth = Math.max(1, textRegion.width - margin.left - margin.right);

  let renderFontSize = fontSize;
  let renderTextWidth = textRealWidth;
  let canvasWidth = bgWidth;
  const canvasHeight = bgHeight; // 当前实现只水平拉伸
  let regionDrawX = textRegion.x;          // region 在输出画布中的实际 X
  let regionDrawWidth = textRegion.width;  // region 在输出画布中的实际宽度
  let needClip = false;

  if (textRealWidth <= usableWidth) {
    // 文本可放下，直接居中绘制
  } else if (stretchTextRegion) {
    // 水平拉伸：增加画布宽度 = 文本超出量
    const delta = textRealWidth - usableWidth;
    canvasWidth = bgWidth + delta;
    regionDrawWidth = textRegion.width + delta;
    // regionDrawX 不变（左段保留）
  } else {
    // 不拉伸：按 overflowStrategy 处理
    switch (overflowStrategy) {
      case 'shrink': {
        // 二分缩小字号到 ≤ usableWidth 同时 ≤ region.height
        const maxLineHeight = Math.max(1, textRegion.height - margin.top - margin.bottom);
        let lo = 1;
        let hi = fontSize;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi + 1) / 2);
          measureCtx.font = buildFontStyle(mid);
          const w = Math.ceil(measureCtx.measureText(text).width);
          // 字号近似 = 字高，需同时满足宽高
          if (w <= usableWidth && mid <= maxLineHeight) lo = mid;
          else hi = mid - 1;
        }
        renderFontSize = Math.max(1, lo);
        measureCtx.font = buildFontStyle(renderFontSize);
        renderTextWidth = Math.ceil(measureCtx.measureText(text).width);
        break;
      }
      case 'clip':
        needClip = true;
        break;
      case 'overflow':
        // 不做处理，原字号绘制
        break;
    }
  }

  // ── 创建输出画布并绘制背景 ──
  const canvas = createCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext('2d');

  if (canvasWidth === bgWidth) {
    // 不拉伸：直接平铺
    ctx.drawImage(bgImage, 0, 0);
  } else {
    // 三段水平拉伸：左段（region 之前）| 中段（region，拉宽）| 右段（region 之后）
    const delta = canvasWidth - bgWidth;
    const leftW = textRegion.x;
    const midW = textRegion.width;
    const rightW = bgWidth - textRegion.x - textRegion.width;
    if (leftW > 0) {
      ctx.drawImage(bgImage,
        0, 0, leftW, bgHeight,
        0, 0, leftW, bgHeight);
    }
    if (midW > 0) {
      ctx.drawImage(bgImage,
        textRegion.x, 0, midW, bgHeight,
        textRegion.x, 0, midW + delta, bgHeight);
    }
    if (rightW > 0) {
      ctx.drawImage(bgImage,
        textRegion.x + textRegion.width, 0, rightW, bgHeight,
        textRegion.x + textRegion.width + delta, 0, rightW, bgHeight);
    }
  }

  // ── 绘制文字（在 regionDrawX..regionDrawX+regionDrawWidth 范围内居中） ──
  ctx.font = buildFontStyle(renderFontSize);
  ctx.fillStyle = fontColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const centerX = regionDrawX + regionDrawWidth / 2;
  const centerY = textRegion.y + textRegion.height / 2;

  if (needClip) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(textRegion.x, textRegion.y, textRegion.width, textRegion.height);
    ctx.clip();
    ctx.fillText(text, centerX, centerY);
    ctx.restore();
  } else {
    ctx.fillText(text, centerX, centerY);
  }

  // 抑制未读警告（textRealHeight 留作未来垂直拉伸用）
  void textRealHeight;
  void renderTextWidth;

  return await encodeCanvas(canvas, encodeOptions);
}
