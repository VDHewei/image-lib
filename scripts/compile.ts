#!/usr/bin/env bun
/**
 * 跨平台 bun --compile 编排脚本
 *
 * 解决 `bun build --compile` + `@napi-rs/canvas` 在多平台下的三大痛点:
 *   1. js-binding.js 里有 13+ 平台分支,Bun bundler 会把所有平台的 .node 都嵌进去,
 *      导致 win32 触发 `Illegal instruction` 崩溃 (见 oven-sh/bun#23904 / #26045)
 *   2. x64 平台需要 `-baseline` target 才能跑在不支持 AVX2 的老 CPU 上
 *   3. 不同 OS/ARCH 要 require 不同的 @napi-rs/canvas-* npm 包
 *
 * 实现思路:
 *   - 用 Bun plugin 把 `@napi-rs/canvas/js-binding.js` 整个替换成
 *     `module.exports = require('@napi-rs/canvas-<目标三元组>')`
 *     —— bundler 只看到一个 require,只嵌入一个 .node
 *   - 通过 `bun build --compile --target=...` 交叉编译到目标平台
 *
 * 用法:
 *   bun run scripts/compile.ts              # 编译当前宿主平台
 *   bun run scripts/compile.ts host         # 同上
 *   bun run scripts/compile.ts all          # 全部 8 个 Bun 官方目标
 *   bun run scripts/compile.ts win-x64      # 单个目标
 *   bun run scripts/compile.ts win-x64 linux-x64 mac-arm64  # 多个目标
 *
 * 可用目标 keys: 见下方 TARGETS
 *
 * 注意:交叉编译需要先安装目标平台对应的 @napi-rs/canvas-* 可选依赖。
 * 例:在 Windows 上想编 Linux 二进制,需要 `bun add -D @napi-rs/canvas-linux-x64-gnu@1.0.0`。
 * 本脚本会在 .node 不存在时打印明确的提示。
 */
import type { BunPlugin } from 'bun';
import path from 'node:path';
import fs from 'node:fs';

//  目标矩阵 ────────────────────────────────────────────────────────────────────

type TargetSpec = {
  /** bun build --target= 的值 */
  bunTarget: string;
  /** 用于 @napi-rs/canvas 平台包名拼接 */
  canvasPkg: string;
  /** 输出文件 (相对项目根) */
  outfile: string;
};

const TARGETS: Record<string, TargetSpec> = {
  //  Windows ──────────────────────────────────────────────────────────────
  // 默认用 `bun-windows-x64`(等价 -modern),用宿主已装的 runtime 直接编,
  // 无需额外下载;现代 CPU (2013+ Haswell 起,有 AVX2) 上跑得最快
  'win-x64': {
    bunTarget: 'bun-windows-x64',
    canvasPkg: '@napi-rs/canvas-win32-x64-msvc',
    outfile: 'dist/image-lib.exe',
  },
  // 老 CPU (无 AVX2,如 2013 前的 Sandy/Ivy Bridge) 可能在 modern 上触发
  // `Illegal instruction`,可改用 baseline。但 baseline runtime 是独立 npm 包
  // (@oven/bun-windows-x64-baseline),首次用要触发下载,有时下载会失败,
  // 此时 `npm install --force` 重装该包后再试
  'win-x64-baseline': {
    bunTarget: 'bun-windows-x64-baseline',
    canvasPkg: '@napi-rs/canvas-win32-x64-msvc',
    outfile: 'dist/image-lib-win-x64-baseline.exe',
  },
  'win-arm64': {
    bunTarget: 'bun-windows-arm64',
    canvasPkg: '@napi-rs/canvas-win32-arm64-msvc',
    outfile: 'dist/image-lib-win-arm64.exe',
  },
  //  macOS ────────────────────────────────────────────────────────────────
  // darwin 不需要 baseline (macOS 早就强制 AVX2 起步)
  'mac-x64': {
    bunTarget: 'bun-darwin-x64',
    canvasPkg: '@napi-rs/canvas-darwin-x64',
    outfile: 'dist/image-lib-mac-x64',
  },
  'mac-arm64': {
    bunTarget: 'bun-darwin-arm64',
    canvasPkg: '@napi-rs/canvas-darwin-arm64',
    outfile: 'dist/image-lib-mac',
  },
  //  Linux (glibc) ────────────────────────────────────────────────────────
  // 同 Windows: 默认用无后缀目标,baseline 单独提供
  'linux-x64': {
    bunTarget: 'bun-linux-x64',
    canvasPkg: '@napi-rs/canvas-linux-x64-gnu',
    outfile: 'dist/image-lib-linux',
  },
  'linux-x64-baseline': {
    bunTarget: 'bun-linux-x64-baseline',
    canvasPkg: '@napi-rs/canvas-linux-x64-gnu',
    outfile: 'dist/image-lib-linux-baseline',
  },
  'linux-arm64': {
    bunTarget: 'bun-linux-arm64',
    canvasPkg: '@napi-rs/canvas-linux-arm64-gnu',
    outfile: 'dist/image-lib-linux-arm64',
  },
  //  Linux (musl, e.g. Alpine) ────────────────────────────────────────────
  'linux-x64-musl': {
    bunTarget: 'bun-linux-x64-musl',
    canvasPkg: '@napi-rs/canvas-linux-x64-musl',
    outfile: 'dist/image-lib-linux-musl',
  },
  'linux-arm64-musl': {
    bunTarget: 'bun-linux-arm64-musl',
    canvasPkg: '@napi-rs/canvas-linux-arm64-musl',
    outfile: 'dist/image-lib-linux-arm64-musl',
  },
};

//  Bun plugin: 把 canvas 的 js-binding.js 替换成只 require 一个平台包 ────────

/**
 * 关键修复:`@napi-rs/canvas/js-binding.js` 里有十多个 `require('./skia.<plat>.node')`
 * 和 `require('@napi-rs/canvas-<plat>')` 平台分支,Bun bundler 会扫描所有 require 字面量,
 * 试图把每一个 .node 都嵌入二进制 —— 触发 #23904 (Windows 崩溃) / #26045 (NAPI 模块混淆)。
 *
 * 这里直接把整个 js-binding.js 替换成一段 stub:
 *   1) 用 `with { type: "file" }` 嵌入对应平台的 `icudtl.dat` (Skia 文本布局必需)
 *      启动时写到 `os.tmpdir()` 和 exe 同目录 —— Skia 的两个搜索位置
 *   2) 只 require 目标平台的那一个 @napi-rs/canvas-* 包,bundler 只嵌一个 .node
 *   3) re-export 原 js-binding.js 的全部命名导出,index.js 的解构 require 不感知差异
 *
 * 不嵌入 icudtl.dat 会导致:
 *   `SkIcuLoader: datafile missing` → `check(fUnicode)` → 进程 Illegal instruction
 *   (Skia 的 SK_ABORT 在 x86 上编译为 UD2 指令)
 */
function makeCanvasStubPlugin(canvasPkg: string): BunPlugin {
  return {
    name: 'napi-canvas-single-platform',
    setup(build) {
      build.onLoad(
        { filter: /[\\/]@napi-rs[\\/]canvas[\\/]js-binding\.js$/ },
        () => {
          return {
            loader: 'js',
            contents: `// stubbed by scripts/compile.ts → 只嵌入 ${canvasPkg}\n` + `
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
// 用 with { type: "file" } 让 Bun bundler 把 icudtl.dat 嵌入二进制
// 返回的是 Bun 虚拟文件系统路径 ($bunfs/...,在 Windows 上形如 B:/~BUN/root/...)
import IcuSrcPath from ${JSON.stringify(canvasPkg + '/icudtl.dat')} with { type: 'file' };

//  bootstrap: 把内嵌的 icudtl.dat 写到 Skia 的搜索路径 
// !! 必须在 require(canvasPkg) 加载 .node 之前完成,因为 Skia 在 .node init 时就要找 ICU
// Skia 在 Windows 上按顺序找:
//   1. os.tmpdir() 下的 icudtl.dat
//   2. 主可执行文件同目录下的 icudtl.dat
//
// 注意: 不能用 fs.copyFileSync(IcuSrcPath, dest) — Bun 的 $bunfs 虚拟路径
// 在 copyFileSync 这条链路上不被识别 (会 ENOENT)。要先 readFileSync 拿 Buffer
// (这条链路 Bun 做了 $bunfs 适配),再 writeFileSync 写出。
const ICU_NAME = 'icudtl.dat';
const candidates = [];
try { candidates.push(join(tmpdir(), ICU_NAME)); } catch (_) {}
try { candidates.push(join(dirname(process.execPath), ICU_NAME)); } catch (_) {}

let icuData = null;
for (const dest of candidates) {
  if (existsSync(dest)) continue;
  try {
    mkdirSync(dirname(dest), { recursive: true });
    if (icuData === null) icuData = readFileSync(IcuSrcPath);
    writeFileSync(dest, icuData);
  } catch (_) {
    // 目录可能只读 (如 /usr/bin),跳过,另一候选可能成功
  }
}

//  加载 native binding 
// 关键: 用 body 内的全局 require() 而不是顶层 import — body 顺序执行,bootstrap 先于此
// 而 import 会被 ESM hoist 到顶,导致 .node 在 bootstrap 前就 init,触发 SkIcuLoader 崩溃
// Bun bundler 在 build 时识别字面量 require(),把目标包(及其 .node)嵌入二进制
const nativeBinding = require(${JSON.stringify(canvasPkg)});

//  re-export: 与原 js-binding.js 末尾 module.exports.X = ... 序列保持一致
//  index.js 用 const {createCanvas, ...} = require('./js-binding') 解构这些命名
export default nativeBinding;
export const {
  GlobalFonts,
  CanvasElement, CanvasGradient, CanvasPattern, CanvasRenderingContext2D,
  FontKey, Image, ImageData, Path,
  PdfDocument, SVGCanvas, ChromaSubsampling,
  clearAllCache, convertSVGTextToPath,
  FillType, PathOp, StrokeCap, StrokeJoin, SvgExportFlag,
  GifEncoder, GifDisposal, LottieAnimation,
} = nativeBinding;
`,
          };
        },
      );
    },
  };
}

//  工具 ────────────────────────────────────────────────────────────────────────

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'bin.ts');

function detectHostKey(): string {
  const p = process.platform;
  const a = process.arch;
  if (p === 'win32' && a === 'x64') return 'win-x64';
  if (p === 'win32' && a === 'arm64') return 'win-arm64';
  if (p === 'darwin' && a === 'x64') return 'mac-x64';
  if (p === 'darwin' && a === 'arm64') return 'mac-arm64';
  if (p === 'linux' && a === 'x64') return 'linux-x64';
  if (p === 'linux' && a === 'arm64') return 'linux-arm64';
  throw new Error(`不支持的宿主平台: ${p} ${a}`);
}

function listAvailableKeys(): string {
  return Object.keys(TARGETS).map(k => '  - ' + k).join('\n');
}

function resolveKeys(argv: string[]): string[] {
  if (argv.length === 0 || argv[0] === 'host') return [detectHostKey()];
  if (argv[0] === 'all') return Object.keys(TARGETS);
  for (const k of argv) {
    if (!TARGETS[k]) {
      throw new Error(`未知目标: "${k}"。可用目标:\n${listAvailableKeys()}\n  - host\n  - all`);
    }
  }
  return argv;
}

/** 校验目标平台的 @napi-rs/canvas-* 包已安装,否则给出清晰提示 */
function assertCanvasPackageInstalled(spec: TargetSpec): void {
  const pkgRoot = path.join(ROOT, 'node_modules', spec.canvasPkg);
  if (!fs.existsSync(pkgRoot)) {
    console.error(`\n[X] 缺少目标平台原生包: ${spec.canvasPkg}`);
    console.error(`    它不在当前宿主的可选依赖里 (optionalDependencies 只装匹配宿主的)。`);
    console.error(`    交叉编译前请先安装:`);
    console.error(`      bun  add -D ${spec.canvasPkg}@1.0.0`);
    console.error(`      pnpm add -D ${spec.canvasPkg}@1.0.0`);
    console.error(`      npm  i   -D ${spec.canvasPkg}@1.0.0 --no-save\n`);
    process.exit(1);
  }
}

//  主流程 ──────────────────────────────────────────────────────────────────────

async function buildOne(key: string): Promise<void> {
  const spec = TARGETS[key]!;
  assertCanvasPackageInstalled(spec);

  const outfile = path.join(ROOT, spec.outfile);
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  // 已存在的二进制先删,避免在 Windows 上"文件被占用"半截写入
  if (fs.existsSync(outfile)) {
    try { fs.rmSync(outfile, { force: true }); } catch {}
  }

  const t0 = Date.now();
  console.log(`\n>>> [${key}] target=${spec.bunTarget}  canvas=${spec.canvasPkg}`);
  console.log(`    → ${spec.outfile}`);

  const result = await Bun.build({
    entrypoints: [ENTRY],
    // Bun 1.3+ 支持 compile 对象式配置
    compile: {
      // 类型里没列出 baseline 字面量,但运行时支持;用 any 旁路
      target: spec.bunTarget as never,
      outfile,
    },
    minify: true,
    plugins: [makeCanvasStubPlugin(spec.canvasPkg)],
  });

  if (!result.success) {
    console.error(`\n[X] 编译失败: ${key}`);
    if (result.logs.length === 0) {
      console.error('  (Bun 没有返回任何 log;通常是 native binding/loader 内部错误,可加 BUN_DEBUG_QUIET_LOGS=0 重试)');
    } else {
      for (const log of result.logs) {
        // log 可能是 BuildMessage / 字符串 / Error
        console.error('  •', typeof log === 'object' ? (log as any).message ?? log : log);
      }
    }
    process.exit(1);
  }

  const stat = fs.statSync(outfile);
  console.log(`[OK] ${spec.outfile}  ${(stat.size / 1024 / 1024).toFixed(2)} MB  (${Date.now() - t0} ms)`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(
      `用法:\n` +
      `  bun run scripts/compile.ts              # 编当前宿主\n` +
      `  bun run scripts/compile.ts host         # 同上\n` +
      `  bun run scripts/compile.ts all          # 编全部目标\n` +
      `  bun run scripts/compile.ts <key> [..]   # 编一个或多个指定目标\n\n` +
      `可用目标:\n${listAvailableKeys()}\n  - host\n  - all\n`,
    );
    return;
  }
  const keys = resolveKeys(argv);
  console.log(`将编译 ${keys.length} 个目标: ${keys.join(', ')}`);
  for (const k of keys) await buildOne(k);
  console.log(`\n[DONE] 全部 ${keys.length} 个目标编译完成`);
}

main().catch(err => {
  console.error('\n[X] 出错:', err instanceof Error ? err.message : err);
  // Bun.build 失败时把详细诊断信息塞在 err 的多个字段里,这里全部 dump
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    for (const key of ['errors', 'logs', 'cause', 'stack'] as const) {
      const v = e[key];
      if (v != null) {
        console.error(`\n[${key}]`);
        if (Array.isArray(v)) {
          for (const item of v) console.error('  •', (item as any)?.message ?? item);
        } else {
          console.error(v);
        }
      }
    }
  }
  process.exit(1);
});
