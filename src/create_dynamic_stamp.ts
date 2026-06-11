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

/**
 * 文字斑驳（白色斑点噪声）效果模式：
 * - 'none'    ：关闭斑点（保持纯色文字）
 * - 'uniform' ：在整个文字区域均匀随机散布白色斑点
 * - 'per-char'：以字符列宽为单元分组随机（每个字符的斑点密度独立波动，**默认**）
 *               更接近真实印章/橡皮章使用磨损或干油墨的视觉
 */
export type SpeckleMode = 'none' | 'uniform' | 'per-char';

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
  /**
   * 字体大小（像素）。
   * - 不指定 + 提供 `textRegion`：**自动跟随原图** = `textRegion.height - margin.top - margin.bottom`
   * - 不指定 + 无 `textRegion`：默认 40
   * - 指定数值：始终使用该值（覆盖自动跟随）
   */
  fontSize?: number;
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

  //  —— 斑驳效果（橡皮章质感） ——

  /** 斑点模式，默认 `'per-char'`（更自然）。传 `'none'` 关闭。 */
  speckleMode?: SpeckleMode;

  /**
   * 目标斑点覆盖率：0-1 之间，表示**文字像素中被打掉/被覆盖的目标占比**，默认 `0.0075`（0.75%）
   *
   * 推荐范围 **0.5% - 1%**（自然轻微的橡皮章/水印磨损）。算法会根据 `speckleSize`
   * 自动反推所需斑点数，因此调整 size 不会改变最终覆盖率。仅 `speckleMode !== 'none'` 时生效。
   */
  speckleDensity?: number;

  /**
   * 单个斑点的"基础半径"（像素），默认 `1.2`。
   * 实际斑点是 4-7 顶点的随机不规则多边形（类似屏幕雪花/锯齿块），
   * 顶点距离中心 0.3 - 1.3 × size，因此真实形状变化大但面积仍极小。
   */
  speckleSize?: number;

  /**
   * 斑点颜色，默认 `'transparent'`（镂空/打洞模式，让背景透出）。
   *
   * - `'transparent'` 或 `'none'`：使用 `globalCompositeOperation = 'destination-out'`
   *    在文字上打透明小洞，模拟橡皮章颜料缺失的视觉效果。
   * - 其它 CSS 颜色（如 `'#FFFFFF'` / `'#000000'`）：使用 `'source-over'` 直接覆盖颜色，
   *    适合需要"白色雪花斑点"或"黑色墨点"等特殊效果时显式指定。
   */
  speckleColor?: string;

  /**
   * 固定随机种子（整数）。用于测试可重复性。
   * 不指定则使用 `Math.random()`（每次输出略有差异）
   */
  speckleSeed?: number;
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
 *
 * **关于字体回退链的重要说明**：@napi-rs/canvas 的 Skia 后端**不会**做 per-glyph 回退。
 * 即 `"Arial, Microsoft YaHei"` 不是"Arial 找不到的字符 fallback 到 YaHei",
 * 而是"用 Arial,找不到字符就渲染豆腐块 □"。所以末段 fallback **必须根据文本内容**
 * 返回**单一**合适字体（含 CJK 字符 → 平台 CJK 字体；否则 → 平台 Latin 字体）。
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

  // —— ③ 系统字体族 / 智能兜底 ——
  // 用户显式指定 → 尊重之。但 Skia 的链回退是 per-glyph 的(实测有效):
  // 若文本含 CJK 而链中无 CJK 字体,自动 append 平台 CJK 字体兜底,
  // Latin 字符仍用用户字体,汉字走回退 —— 与浏览器行为一致,杜绝豆腐块。
  if (options.fontFamily) {
    if (hasCJK(options.text) && !familyChainHasCJK(options.fontFamily)) {
      const cjk = pickSmartFallbackFamily(options.text);
      console.warn(
        `[loadFont] 文本含中日韩字符但 fontFamily "${options.fontFamily}" 无 CJK 字体,` +
        `已自动追加 "${cjk}" 兜底`,
      );
      return `${options.fontFamily}, "${cjk}"`;
    }
    return options.fontFamily;
  }
  // 未指定 → 按文本内容智能选,返回 GlobalFonts 里**实际存在**的单一字体名
  return pickSmartFallbackFamily(options.text);
}

/** Unicode 范围正则:常见 CJK 块(中日韩统一表意 / 假名 / 谚文 / CJK 兼容标点等) */
const CJK_PATTERN = /[\u2e80-\u2eff\u2f00-\u2fdf\u3000-\u303f\u3040-\u30ff\u3100-\u312f\u3130-\u318f\u31a0-\u31bf\u31c0-\u31ef\u31f0-\u31ff\u3200-\u32ff\u3300-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;

/** 文本是否包含 CJK 字符(用于决定 fallback 字体选 CJK 还是 Latin) */
function hasCJK(text: string): boolean {
  return CJK_PATTERN.test(text);
}

/**
 * 已知 CJK 字体名关键词(不区分大小写)。
 * 覆盖 Windows / macOS / Linux 常见中日韩字体的命名习惯。
 * 用于判断用户给的 font-family 链中是否已含 CJK 字体。
 */
const CJK_FONT_KEYWORD = new RegExp(
  [
    'yahei', 'jhenghei', 'simsun', 'simhei', 'nsimsun', 'fangsong', 'kaiti', 'dengxian', 'mingliu',
    'pingfang', 'hiragino', 'heiti', 'songti', 'stsong', 'stheiti', 'stkaiti', 'stfangsong',
    'noto\\s*(sans|serif)\\s*(cjk|sc|tc|hk|jp|kr)', 'source\\s*han', 'sarasa',
    'wenquanyi', 'wqy', 'droid\\s*sans\\s*fallback',
    'ms\\s*(gothic|mincho|pgothic|pmincho)', 'yu\\s*(gothic|mincho)', 'meiryo',
    'malgun', 'batang', 'gulim', 'dotum', 'apple\\s*sd\\s*gothic',
    '黑体', '宋体', '楷体', '仿宋', '微软雅黑', '苹方', '思源',
  ].join('|'),
  'i',
);

/**
 * 判断 CSS font-family 链中是否已包含 CJK 字体。
 * 链按逗号拆分,去引号/空白后:
 *  1. 名字匹配已知 CJK 关键词 → true
 *  2. 名字在 GlobalFonts 注册且属于 CJK_FALLBACK_CANDIDATES → true
 */
function familyChainHasCJK(familyChain: string): boolean {
  const families = familyChain
    .split(',')
    .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
  const platformCJK = new Set(
    Object.values(CJK_FALLBACK_CANDIDATES).flat().map(s => s.toLowerCase()),
  );
  return families.some(f => CJK_FONT_KEYWORD.test(f) || platformCJK.has(f.toLowerCase()));
}

/** 各平台优先尝试的 CJK 字体列表(顺序 = 偏好) */
const CJK_FALLBACK_CANDIDATES: Record<string, readonly string[]> = {
  win32: [
    'Microsoft YaHei',     // Windows 简中默认
    'Microsoft JhengHei',  // Windows 繁中
    'SimHei', 'SimSun',    // 老牌中文字体
    'Malgun Gothic',       // Windows 韩文
    'Yu Gothic', 'MS Gothic', // Windows 日文
    'Source Han Sans CN',  // 思源黑体(若装了)
    'Noto Sans CJK SC', 'Noto Sans SC',
  ],
  darwin: [
    'PingFang SC',         // macOS 简中默认 (10.11+)
    'PingFang TC', 'PingFang HK',
    'Heiti SC', 'STHeiti', // macOS 老版中文
    'Hiragino Sans GB',    // macOS 简中(辅助)
    'Hiragino Sans',       // macOS 日文
    'Apple SD Gothic Neo', // macOS 韩文
    'Source Han Sans CN', 'Noto Sans CJK SC',
  ],
  linux: [
    'Noto Sans CJK SC',    // Linux 标准 CJK
    'Noto Sans SC',
    'Source Han Sans CN',
    'WenQuanYi Micro Hei', 'WenQuanYi Zen Hei',
    'Droid Sans Fallback',
    'DejaVu Sans',         // 至少能渲染部分 CJK
  ],
};

/** 各平台优先尝试的 Latin 字体列表 */
const LATIN_FALLBACK_CANDIDATES: Record<string, readonly string[]> = {
  win32:  ['Arial', 'Segoe UI', 'Tahoma', 'Verdana'],
  darwin: ['Helvetica Neue', 'Helvetica', 'Arial', 'San Francisco'],
  linux:  ['DejaVu Sans', 'Liberation Sans', 'Noto Sans', 'Arial'],
};

/**
 * 智能挑选已注册的兜底字体名(返回**单一**家族名,因为 Skia 不做 per-glyph fallback)。
 * - 文本含 CJK → 优先选平台 CJK 字体
 * - 否则       → 优先选平台 Latin 字体
 * - 候选都不在 GlobalFonts → 抓 GlobalFonts.families 的第一个作最终兜底
 * - 极端情况:GlobalFonts 为空 → 返回 'sans-serif' (让 Skia 走自己的默认)
 */
function pickSmartFallbackFamily(text: string): string {
  const plat = process.platform;
  const list = (hasCJK(text) ? CJK_FALLBACK_CANDIDATES : LATIN_FALLBACK_CANDIDATES);
  const candidates = list[plat] ?? list.linux!;
  for (const name of candidates) {
    if (GlobalFonts.has(name)) return name;
  }
  // 候选全 miss:翻一下系统装的字体,挑第一个能用的
  try {
    const families = GlobalFonts.families as ReadonlyArray<{ family: string } | string>;
    if (Array.isArray(families) && families.length > 0) {
      const first = families[0]!;
      return typeof first === 'string' ? first : first.family;
    }
  } catch { /* 忽略 */ }
  return 'sans-serif';
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
 *
 * 文字风格：
 *   - 字号默认：`textRegion` 存在时跟随 region 高度；否则 40
 *   - 斑驳质感：默认 `speckleMode='per-char'` + `speckleColor='transparent'`，
 *               在文字上随机打**透明不规则多边形小洞**（类似屏幕雪花/锯齿），
 *               目标覆盖率默认 0.75%（推荐 0.5%-1% 区间）。传 `speckleMode='none'` 可关闭。
 */
export async function generateDynamicStamp(options: GenerateStampOptions): Promise<Buffer> {
  const text = options.text;
  const isBold = options.fontBold !== false ? 'bold ' : '';

  // 1. 字体加载与样式构造
  const fontFamily = await loadFont(options);
  const buildFontStyle = (size: number) => `${isBold}${size}px ${fontFamily}`;

  const fontColor = options.fontColor || '#FF99A8';
  const margin = options.margin || { top: 20, right: 20, bottom: 20, left: 20 };
  const stretchTextRegion = options.stretchTextRegion !== false; // 默认 true
  const overflowStrategy: OverflowStrategy = options.overflowStrategy || 'shrink';

  // —— 字号自动跟随 textRegion：未指定 fontSize 时
  // 若提供 textRegion → 用 region 高度去除上下边距，否则默认 40
  let fontSize: number;
  if (options.fontSize !== undefined) {
    fontSize = options.fontSize;
  } else if (options.textRegion) {
    const inferred = options.textRegion.height - margin.top - margin.bottom;
    fontSize = Math.max(8, Math.floor(inferred));
  } else {
    fontSize = 40;
  }

  // —— 斑驳参数 ——
  const speckleConfig = resolveSpeckleConfig(options);

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
      speckleConfig,
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

  // —— 斑驳效果（路径 A）：作用范围 = 文字外接矩形
  if (speckleConfig.mode !== 'none') {
    const textBoxX = Math.floor(finalCanvasWidth / 2 - textRealWidth / 2);
    const textBoxY = Math.floor(finalCanvasHeight / 2 - textRealHeight / 2);
    applySpeckle(
      ctx,
      textBoxX, textBoxY, textRealWidth, textRealHeight,
      fontColor, speckleConfig,
    );
  }

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
  speckleConfig: SpeckleConfig;
}

async function renderStampInRegion(p: RenderInRegionParams): Promise<Buffer> {
  const {
    bgImage, bgWidth, bgHeight,
    text, textRegion, fontSize, textRealWidth, textRealHeight,
    margin, stretchTextRegion, overflowStrategy,
    buildFontStyle, fontColor, measureCtx, encodeOptions,
    speckleConfig,
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

  // —— 斑驳效果：作用范围 = textRegion 矩形（不超出，避免污染框外背景）
  if (speckleConfig.mode !== 'none') {
    applySpeckle(
      ctx,
      textRegion.x, textRegion.y, regionDrawWidth, textRegion.height,
      fontColor, speckleConfig,
    );
  }

  // 抑制未读警告（textRealHeight 留作未来垂直拉伸用）
  void textRealHeight;
  void renderTextWidth;

  return await encodeCanvas(canvas, encodeOptions);
}

//  —— 斑驳效果（橡皮章质感）实现 ——

interface SpeckleConfig {
  mode: SpeckleMode;
  density: number;     // 0-1：目标"被打掉/覆盖"的文字像素占比
  size: number;        // 多边形基础半径 px
  color: string;       // 斑点颜色（仅 transparent === false 时使用）
  transparent: boolean; // true → destination-out 打透明洞；false → 直接填色
  rng: () => number;   // 0-1 随机源
}

/** 简单 mulberry32 PRNG —— 32-bit seed → [0,1) */
function createPRNG(seed: number | undefined): () => number {
  if (seed === undefined) return Math.random;
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 判定颜色字符串是否为"透明"语义（用于触发 destination-out 打洞模式） */
function isTransparentColor(c: string | undefined): boolean {
  if (c === undefined) return true; // 未传 → 默认透明
  const s = c.trim().toLowerCase();
  if (s === 'transparent' || s === 'none') return true;
  // rgba(...,0) / rgba(...,0.0)
  const m = /^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*(0(?:\.0+)?)\s*\)$/.exec(s);
  if (m) return true;
  // #RRGGBBAA 末两位 00
  if (/^#[0-9a-f]{6}00$/.test(s)) return true;
  // #RGBA 末一位 0
  if (/^#[0-9a-f]{3}0$/.test(s)) return true;
  return false;
}

/** 把宽松的 options 合并为严格的 SpeckleConfig，含参数校验 */
function resolveSpeckleConfig(opts: GenerateStampOptions): SpeckleConfig {
  const mode: SpeckleMode = opts.speckleMode ?? 'per-char';
  if (mode !== 'none' && mode !== 'uniform' && mode !== 'per-char') {
    throw new RangeError(`speckleMode 必须是 'none'|'uniform'|'per-char'，实际 "${mode}"`);
  }
  // 默认 0.75%：用户要求 0.5%-1% 文字面积覆盖（屏幕雪花/橡皮章自然磨损）
  const density = opts.speckleDensity ?? 0.0075;
  if (typeof density !== 'number' || !Number.isFinite(density) || density < 0 || density > 1) {
    throw new RangeError(`speckleDensity 必须在 [0,1] 之间，实际 ${density}`);
  }
  const size = opts.speckleSize ?? 1.2;
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0 || size > 20) {
    throw new RangeError(`speckleSize 必须在 (0,20] 之间，实际 ${size}`);
  }
  // 默认 'transparent' → destination-out 打洞
  const colorRaw = opts.speckleColor ?? 'transparent';
  const transparent = isTransparentColor(colorRaw);
  return {
    mode,
    density,
    size,
    color: colorRaw,
    transparent,
    rng: createPRNG(opts.speckleSeed),
  };
}

/**
 * 把 #RRGGBB / #RGB / rgb(r,g,b) 解析为 RGB 元组
 * 解析失败回退到默认粉色
 */
function parseColorToRGB(color: string): [number, number, number] {
  if (typeof color !== 'string') return [255, 153, 168];
  const s = color.trim().toLowerCase();
  // #RGB
  let m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
  if (m) {
    return [parseInt(m[1]! + m[1]!, 16), parseInt(m[2]! + m[2]!, 16), parseInt(m[3]! + m[3]!, 16)];
  }
  // #RRGGBB
  m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(s);
  if (m) {
    return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
  }
  // rgb(...)
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(s);
  if (m) {
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  return [255, 153, 168];
}

/**
 * 在文字外接矩形内打**不规则透明小洞**（屏幕雪花/橡皮章磨损质感）
 *
 * 算法保证：被打掉/覆盖的文字像素比例 ≈ `cfg.density`（与斑点 size 解耦）
 *
 * 形状：每个斑点是 4-7 个顶点的随机不规则凸多边形（类似锯齿三角/五边/六边形），
 *      顶点角度均匀分布并带 ±30% 抖动，半径在 `[0.3, 1.3] × size` 间，
 *      模拟屏幕雪花/电视噪点/橡皮章颜料剥落的不规则形态。
 *
 * 颜色：
 *   - `cfg.transparent === true`（默认）→ `globalCompositeOperation='destination-out'`
 *     直接把文字像素打成透明（露出背景），不引入新颜色，最自然。
 *   - `cfg.transparent === false` → 直接用 `cfg.color` 实色覆盖（兼容 white/black 模式）。
 *
 * 步骤：
 *   1. 读取矩形内 imageData，扫描"文字像素"（接近 fontColor 的有色像素）
 *   2. 估算单多边形的平均覆盖面积 ≈ π × size² × `ANTIALIAS_COMPENSATION`
 *   3. 反推目标斑点数 N = max(1, round(candidates × density / 单斑面积))
 *   4. 按模式抽样：
 *      - uniform : 全部候选按 prob = N / candidates 均匀抽样
 *      - per-char: 按 x 分桶（桶宽 ≈ 一个字符），每桶 prob 带 ±35% 抖动，
 *                  全局总数仍 ≈ N
 *   5. 在抽中坐标上构建多边形 path 并 fill（destination-out 或 source-over）
 *
 * 注意：传入的 (x,y,w,h) 必须在画布范围内，否则会被 clamp。
 */
function applySpeckle(
  ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  x: number, y: number, w: number, h: number,
  fontColor: string,
  cfg: SpeckleConfig,
): void {
  if (cfg.mode === 'none' || cfg.density === 0) return;
  // canvas 实际尺寸（用 ctx.canvas 获取）
  const cvs = ctx.canvas;
  const ix = Math.max(0, Math.floor(x));
  const iy = Math.max(0, Math.floor(y));
  const iw = Math.min(cvs.width - ix, Math.ceil(w));
  const ih = Math.min(cvs.height - iy, Math.ceil(h));
  if (iw <= 0 || ih <= 0) return;

  const [fr, fg, fb] = parseColorToRGB(fontColor);
  const tol = 80; // 颜色匹配容差（足够覆盖抗锯齿边缘）

  const data = ctx.getImageData(ix, iy, iw, ih).data;
  // 收集文字像素相对坐标
  const candidates: number[] = []; // 平铺存储 [x0,y0,x1,y1,...]
  for (let py = 0; py < ih; py++) {
    for (let px = 0; px < iw; px++) {
      const i = (py * iw + px) * 4;
      const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!, a = data[i + 3]!;
      if (a < 64) continue; // 跳过透明像素
      const dr = r - fr, dg = g - fg, db = b - fb;
      if (dr * dr + dg * dg + db * db <= tol * tol) {
        candidates.push(px, py);
      }
    }
  }
  const candidateCount = candidates.length / 2;
  if (candidateCount === 0) return;

  // —— 目标覆盖率反推斑点数 ——
  const targetPunchedPixels = candidateCount * cfg.density;
  // 单个不规则多边形的"有效像素打扰数" ≈ π × size² × 抗锯齿/destination-out 折算
  // 经验值 0.12：实测下与白色圆斑(0.7)相比约 ~5.8×，原因：
  //   1. 多边形面积 ≈ 圆面积 × 0.55（顶点 radius 0.3-1.3 抖动平均）
  //   2. destination-out 边缘是连续 alpha 衰减，大量像素只被"部分擦除"（alpha 0.3-0.7），
  //      测试的 pink 阈值需要 alpha 接近 0 才会"流失"，因此实际"完全打掉"像素少
  //   3. 细笔画字母（Approved/Draft 等小写）候选像素多在 stroke 边缘，
  //      多边形落点更易跨出有色区，单 dot 有效擦除率比粗体低
  // 经 0.5%-1% 目标实测校准（默认 density=0.0075、size=1.2）：
  //   各类字形（粗体/细体）覆盖率均落在 0.5%-1.0% 区间内，符合用户要求
  const ANTIALIAS_COMPENSATION = 0.12;
  // 注：floor 用 0.1 而非 1，否则 π × size² × compensation 在 size<2 时会被 clamp 失效，
  // 让 compensation 调参无效。0.1 仍能挡住极端 size→0 的除零风险。
  const pixelsPerDot = Math.max(0.1, Math.PI * cfg.size * cfg.size * ANTIALIAS_COMPENSATION);
  const targetDots = Math.max(1, Math.round(targetPunchedPixels / pixelsPerDot));
  // 抽样概率 = 目标数 / 候选数，clamp 到 [0,1]
  const baseProb = Math.min(1, targetDots / candidateCount);

  // 抽样
  const picked: Array<[number, number]> = [];
  if (cfg.mode === 'uniform') {
    for (let k = 0; k < candidates.length; k += 2) {
      if (cfg.rng() < baseProb) picked.push([candidates[k]!, candidates[k + 1]!]);
    }
  } else {
    // per-char：按 x 分桶，桶宽 ≈ 一个字符（粗略用 sqrt(候选数) 做兜底，最小 16）
    const bucketWidth = Math.max(16, Math.floor(Math.sqrt(candidateCount) * 1.5));
    const bucketProb = new Map<number, number>(); // 桶 → 该桶实际抽样概率（带抖动）
    for (let k = 0; k < candidates.length; k += 2) {
      const px = candidates[k]!;
      const bucket = Math.floor(px / bucketWidth);
      let prob = bucketProb.get(bucket);
      if (prob === undefined) {
        // 抖动 ±35%（0.65× ~ 1.35×），clamp 到 [0,1]
        // 不用 ±50% 是因为单字符在极端抖动 + 抽样方差下可能突破上界
        prob = Math.min(1, baseProb * (0.65 + cfg.rng() * 0.7));
        bucketProb.set(bucket, prob);
      }
      if (cfg.rng() < prob) picked.push([px, candidates[k + 1]!]);
    }
  }

  // —— 绘制不规则多边形（屏幕雪花/锯齿斑驳） ——
  ctx.save();
  if (cfg.transparent) {
    // destination-out 模式：把文字像素打成透明（露出底层背景）
    // fillStyle 的颜色不影响结果，但必须 opaque（alpha=1）才能完全擦除
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
  } else {
    // source-over 模式：用 cfg.color 实色覆盖（兼容白/黑斑点旧行为）
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = cfg.color;
  }
  for (const [px, py] of picked) {
    // 多边形中心：像素中心 + 微抖动（±0.3px 避免严格对齐网格）
    const cx = ix + px + 0.5 + (cfg.rng() - 0.5) * 0.6;
    const cy = iy + py + 0.5 + (cfg.rng() - 0.5) * 0.6;
    // 顶点数 4-7（避免 3 的过分尖锐）
    const n = 4 + Math.floor(cfg.rng() * 4);
    const angleStep = (Math.PI * 2) / n;
    const baseAngle = cfg.rng() * Math.PI * 2; // 整体旋转随机
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      // 角度：均匀分布 + ±30% 抖动（保持顶点环绕但不规则）
      const angle = baseAngle + angleStep * i + (cfg.rng() - 0.5) * angleStep * 0.6;
      // 半径：基础 size × [0.3, 1.3]（顶点远近大幅变化 → 屏幕雪花锯齿感）
      const r = cfg.size * (0.3 + cfg.rng() * 1.0);
      const vx = cx + Math.cos(angle) * r;
      const vy = cy + Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(vx, vy);
      else ctx.lineTo(vx, vy);
    }
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}
