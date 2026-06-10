<div align="center">

<img src="./assets/logo-256.png" alt="image_lib logo" width="180" />

# image_lib

**轻量级图片处理库（Bun & Node），基于 [@napi-rs/canvas](https://github.com/Brooooooklyn/canvas)：动态文本印章生成 + 颜色定位透明抠图。**

[![Bun](https://img.shields.io/badge/runtime-Bun%20%E2%89%A51.0-fbf0df?logo=bun)](https://bun.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Tests](https://img.shields.io/badge/tests-54%20passing-brightgreen)](#测试)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](#许可证)

[English](./README.md)  [简体中文](./README.zh-CN.md)

</div>

---

##  特性

-  **颜色定位抠图**  按目标颜色（默认黄色）定位最小外接矩形，可选保留**框外**或**框内**，剩余白底默认透明。
-  **印章自动对齐**  `cropTransparentBackground` 返回抠除矩形信息，可直接喂给 `generateDynamicStamp`，文字精准落在"洞"里。
-  **智能文本适配**  超长文本默认**水平拉伸画布**；也可关闭拉伸，按 `shrink`（缩字号）/`clip`（裁剪）/`overflow`（溢出）三种策略处理。
-  **三级字体加载**  远程 URL（自动缓存） 本地字体文件  系统字体族回退。开箱即用支持中英文混排。
-  **字体缓存沙箱**  白名单沙箱 + 系统目录黑名单 + 跨平台文件名规范化，防止误写系统目录。
-  **零依赖 CLI**  单一 `image-lib` 命令含 `stamp` / `crop` 子命令，无需 `commander` / `yargs`。
-  **5 种导出格式**  `png` / `jpeg` / `webp` / `avif` / `gif`，质量参数与 AvifConfig 严格分发。

---

##  安装

```bash
# Bun（推荐）
bun add image_lib

# 或 pnpm / npm / yarn
pnpm add image_lib
npm  install image_lib
yarn add image_lib
```

> 需要 **Bun  1.0** 或 **Node  18**（依赖 `@napi-rs/canvas` 预编译二进制）。

---

##  快速上手

```ts
import {
  cropTransparentBackground,
  generateDynamicStamp,
} from "image_lib";
import { writeFileSync } from "fs";

// 1. 抠图：定位黄色框  框内整块抠透明，框外白底也透明
const { buffer, region } = await cropTransparentBackground({
  sourceImgPath: "images/draft.png",
  outputPath:    "out/clean-bg.png",
  // keepRegion: "outside"（默认） 保留框外
  // transparentColor 默认白色 {r:255,g:255,b:255}
});

console.log(`抠除矩形: ${region.width}x${region.height} 起点 (${region.x},${region.y})`);

// 2. 印章：把文字精准画到抠除矩形内
const stamp = await generateDynamicStamp({
  backgroundPath: "out/clean-bg.png",
  text:           "机密文件",
  textRegion:     region,           //  自动对齐，零手算坐标
  // stretchTextRegion: true（默认） 超长文本水平拉伸画布
  fontColor:      "#FF99A8",
});
writeFileSync("out/final-stamp.png", stamp);
```

---

##  命令行

```bash
# 安装后
image-lib --help
image-lib stamp --help
image-lib crop  --help

# 或直接用 Bun 跑源码
bun run src/bin.ts <command> ...
```

### `crop`  颜色定位抠图

```bash
# 默认：保留黄色框外，剩余白底透明  输出与源图同尺寸
image-lib crop --src images/draft.png --out out/clean.png

# 输出会直接打印可复用的 region 坐标：
#   region: x=25 y=175 w=248 h=73
#   作为 stamp --text-region 参数: "25,175,248,73"

# 切换为保留框内，输出裁剪到框尺寸
image-lib crop --src images/draft.png --out out/inside.png --keep inside

# 关闭白底透明化，保留所有原色
image-lib crop --src images/draft.png --out out/no-trans.png --no-transparent
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--src`, `--source <path>` |  | **必填。** 源图路径 |
| `--out`, `--output <path>` | `out/clean-bg.<ext>` | 输出路径（建议 `.png` 保留透明度） |
| `--keep <outside\|inside>` | `outside` | 保留框外或框内 |
| `--target-color <r,g,b>` | `255,215,0` | 框选颜色（用于定位矩形） |
| `--target-tolerance <n>` | `80` | 框选色容差（欧氏距离） |
| `--transparent-color <r,g,b>` | `255,255,255` | 保留区域内要透明化的颜色 |
| `--transparent-tolerance <n>` | `40` | 透明色容差 |
| `--no-transparent` | 关闭 | 显式禁用颜色透明化 |
| `--padding <px>` | `0` | `outside`：透明洞**向内收缩**（保边框）`inside`：裁剪边界**向外扩展** |
| `--format <fmt>` | `png` | `png` / `jpeg` / `webp` / `avif` / `gif` |
| `--quality <0-100>` |  | JPEG/WebP/GIF 质量 |

### `stamp`  动态文本印章

```bash
# 自动宽度（不指定 textRegion） 原"三段拉伸"行为
image-lib stamp --bg images/draft.png --text "草稿" --out out/zh.png

# 指定 textRegion：文字精准落入矩形
image-lib stamp --bg out/clean.png --text "DRAFT v1.0" \
  --text-region "25,175,248,73" --out out/exact.png

# 长文本  默认拉伸画布
image-lib stamp --bg out/clean.png --text "这是一段超长的草稿文字" \
  --text-region "25,175,248,73" --out out/stretched.png

# 长文本  关闭拉伸 + 自动缩小字号
image-lib stamp --bg out/clean.png --text "这是一段超长的草稿文字" \
  --text-region "25,175,248,73" --no-stretch --overflow shrink --out out/shrunk.png
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--bg`, `--background <path>` |  | **必填。** 背景图 |
| `--text <string>` |  | **必填。** 印章文字（1255 字） |
| `--out`, `--output <path>` | `out/stamp.<ext>` | 输出路径 |
| `--text-region <x,y,w,h>` |  | 文字填充矩形（绝对像素） |
| `--no-stretch` | 关闭 | 文字超出矩形时不拉伸画布 |
| `--overflow <strategy>` | `shrink` | `shrink` / `clip` / `overflow`（仅 `--no-stretch` 时生效） |
| `--font-url <url>` |  | 远程字体 URL（优先级最高，自动缓存） |
| `--font-file <path>` |  | 本地字体文件（`.ttf` / `.otf` / `.woff` / `.woff2`） |
| `--font-family <css>` | 跨平台后备 | CSS font-family 字符串 |
| `--font-name <name>` | `StampFont` | 注册到 `GlobalFonts` 的字体名 |
| `--font-size <px>` | `40` | |
| `--font-color <#hex>` | `#FF99A8` | |
| `--no-bold` | 关闭 | 关闭加粗 |
| `--margin <n>` | `20` | 统一四边距（或 `--margin-top/right/bottom/left`） |
| `--format <fmt>` | `png` | `png` / `jpeg` / `webp` / `avif` / `gif` |
| `--quality <0-100>` |  | JPEG/WebP/GIF 质量 |

---

##  库 API

### `cropTransparentBackground(options): Promise<CropResult>`

颜色定位抠图，两种保留模式：

```ts
interface CropOptions {
  sourceImgPath: string;                  // 必填
  outputPath?: string;                    // 提供则同时落盘
  keepRegion?: "outside" | "inside";      // 默认 "outside"
  targetColor?: RGB;                      // 默认黄色 {r:255,g:215,b:0}
  targetTolerance?: number;               // 默认 80
  transparentColor?: RGB | null;          // 默认白色；传 null 禁用
  transparentTolerance?: number;          // 默认 40
  padding?: number;                       // 默认 0
  encodeOptions?: EncodeFormat | EncodeOptions;
}

interface CropResult {
  buffer: Buffer;                         // 编码后图片
  region: { x: number; y: number; width: number; height: number };
  width:  number;                         // 输出画布宽度
  height: number;                         // 输出画布高度
}
```

| 模式 | 输出尺寸 | `region` 含义 | `padding` 语义 |
|---|---|---|---|
| `outside`（默认） | 源图尺寸 | 画布中"透明洞"的位置 | **向内收缩**透明区（保留彩色边框本身） |
| `inside` | 矩形尺寸 | 始终是 `{x:0, y:0, w:画布宽, h:画布高}` | **向外扩展**裁剪边界 |

### `generateDynamicStamp(options): Promise<Buffer>`

```ts
interface GenerateStampOptions {
  backgroundPath: string;                 // 必填
  text: string;                           // 必填（1255 字）
  fontSize?: number;                      // 默认 40
  fontColor?: string;                     // 默认 '#FF99A8'
  fontBold?: boolean;                     // 默认 true
  fontFamily?: string;                    // CSS font-family
  fontURL?: string;                       // 远程 URL（自动缓存）
  fontFilePath?: string;                  // 本地 .ttf/.otf/.woff/.woff2
  fontName?: string;                      // 注册到 GlobalFonts
  margin?: { top: number; right: number; bottom: number; left: number };
  encodeOptions?: EncodeFormat | EncodeOptions;

  //  矩形模式（新增） 
  textRegion?: { x: number; y: number; width: number; height: number };
  stretchTextRegion?: boolean;            // 默认 true（指定 textRegion 时）
  overflowStrategy?: "shrink" | "clip" | "overflow";  // 默认 "shrink"
}
```

**两种渲染模式：**

| 条件 | 行为 |
|---|---|
| 不指定 `textRegion` | 原三段拉伸  画布按文本宽度自适应，背景水平拉伸，左右固定 15% 边缘 |
| 指定 `textRegion`，文本不超长 | 画布保持背景图原尺寸，文字在矩形中央绘制 |
| 指定 `textRegion`，文本超长，`stretchTextRegion: true`*（默认）* | 画布水平加宽容纳完整文本，矩形拉伸，左右背景原样保留 |
| 指定 `textRegion`，文本超长，`stretchTextRegion: false` | 按 `overflowStrategy` 处理：<br> `shrink`  二分缩小字号到适配<br> `clip`  保持字号，裁剪到矩形内<br> `overflow`  保持字号，允许溢出 |

### 字体加载（三级回退）

`loadFont(options)` 按优先级依次尝试，返回可用的字体族名：

1. **`fontURL`**  下载到 `font_cache/`，注册到 `GlobalFonts`。再次调用走本地缓存。
2. **`fontFilePath`**  `GlobalFonts.registerFromPath`，无需下载。
3. **`fontFamily`**  直接透传为 CSS 字符串，依赖系统字体。

```ts
// 推荐：jsDelivr 镜像的 @fontsource（woff 小，URL 稳定）
const NOTO_SANS_SC =
  "https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-sc@5/files/noto-sans-sc-chinese-simplified-700-normal.woff";

await generateDynamicStamp({
  backgroundPath: "out/clean-bg.png",
  text:           "草稿 DRAFT",
  fontURL:        NOTO_SANS_SC,
  fontName:       "NotoSansSC",
});
```

### 编码工具

```ts
import {
  encodeCanvas,
  normalizeEncodeOptions,
  getMimeForFormat,
  getExtForFormat,
} from "image_lib";

// 已正确对接 canvas.encode() 所有重载
await encodeCanvas(canvas, "png");
await encodeCanvas(canvas, { format: "jpeg", quality: 80 });
await encodeCanvas(canvas, { format: "avif", avifConfig: { speed: 10 } });

getMimeForFormat("webp");  //  "image/webp"
getExtForFormat("jpeg");   //  ".jpg"
```

---

##  测试

```bash
bun test                  # 全部用例（54 个）
bun run test:image        # 仅抠图测试（14 个）
bun run test:stamp        # 仅印章测试（40 个）
bun run test:watch        # 监听模式
```

测试产物落在 `tests/data/`（自动创建）。`bun run clean:test` 清空。

**测试覆盖亮点：**
- `outside` / `inside` 两种抠图模式 + padding + 自定义颜色 + 异常路径
- 默认白底透明化的开启 / 关闭
- `textRegion` 渲染：stretch / no-stretch + shrink / clip / overflow
- 端到端链路：`crop` 返回的 `region` 直接喂给 `stamp`
- 9 种语言文本（英文 / 中文 / 中英混合 / emoji 回退）
- 6 个长度边界（1, 10, 50, 100, 200, 255 字）
- 3 种字体源（远程含缓存、本地文件、系统字体族）
- 5 种导出格式 + 质量 / AvifConfig

---

##  脚本

| 命令 | 说明 |
|---|---|
| `bun test` | 跑全部测试 |
| `bun run test:image` | 仅跑 `cropTransparentBackground` 测试 |
| `bun run test:stamp` | 仅跑 `generateDynamicStamp` 测试 |
| `bun run clean:test` | 清理 `tests/data/`、`src/font_cache/`、`font_cache/` |
| `bun run clean:all`  | `clean:test` + 清理 `out/` 与 `dist/` |
| `bun run build` | 打包库到 `dist/`（ESM，含 sourcemap） |
| `bun run build:logo` | 把 `assets/logo.svg` 栅格化为 PNG（128/256/512） |
| `bun run compile` | 编译当前平台的单文件 CLI |
| `bun run compile:win\|linux\|mac` | 交叉编译各平台 CLI |
| `bun run demo:stamp` | 快速演示：用 `images/draft.png` 生成印章 |
| `bun run demo:crop` | 快速演示：抠取 `images/draft.png` |

---

##  目录结构

```
image_lib/
 src/
    main.ts                  # 库公共 API 入口
    bin.ts                   # CLI 入口（#!/usr/bin/env bun）
    create_image.ts          # cropTransparentBackground 实现
    create_dynamic_stamp.ts  # generateDynamicStamp + 字体 + 编码
 tests/
    create_image.test.ts     # 14 个抠图测试
    create_dynamic_stamp.test.ts  # 40 个印章测试
    data/                    # 测试产物（gitignore）
 scripts/
    clean-test.ts            # 清理脚本
    build-logo.ts            # SVG  PNG 栅格化
 assets/
    logo.svg                 # 矢量原图
    logo-{128,256,512}.png   # 栅格输出
 images/draft.png             # 示例输入（测试 / demo 用）
 package.json
```

---

##  跨平台说明

- **Linux/Docker**：安装 fontconfig 与后备字体（中文请装 `fonts-noto-cjk`），确保系统字体路径可用。
- **Windows**：自动走 `C:\Windows\Fonts`，字体缓存落在 `src/font_cache/`（已白名单授权）。
- **自定义缓存根目录**：设置环境变量 `FONT_CACHE_ALLOWED_ROOTS`（Windows 用 `;` 分隔，POSIX 用 `:`）扩展沙箱根目录。

---

##  许可证

[MIT](./LICENSE)  2026

---

<div align="center">

用  与  烤制  如果帮到你了，给我们一个 Star  吧！

</div>