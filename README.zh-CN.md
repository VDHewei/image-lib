<div align="center">

<img src="./assets/logo-256.png" alt="image_lib logo" width="180" />

# image_lib

**轻量级图片处理库（Bun & Node），基于 [@napi-rs/canvas](https://github.com/Brooooooklyn/canvas)：动态文本印章生成 + 颜色定位透明抠图。**

[![Bun](https://img.shields.io/badge/runtime-Bun%20%E2%89%A51.0-fbf0df?logo=bun)](https://bun.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Tests](https://img.shields.io/badge/tests-75%20passing-brightgreen)](#测试)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](#许可证)

[English](./README.md)  [简体中文](./README.zh-CN.md)

</div>

---

##  特性

-  **颜色定位抠图**  按目标颜色（默认黄色）定位最小外接矩形，可选保留**框外**或**框内**，剩余白底默认透明。
-  **印章自动对齐**  `cropTransparentBackground` 返回抠除矩形信息，可直接喂给 `generateDynamicStamp`，文字精准落在"洞"里。
-  **字号自动跟随**  指定 `textRegion` 时，字号默认 = `region.height - 上下 margin`，无需手算。
-  **屏幕雪花斑驳质感**  默认在文字上打**透明不规则多边形小洞**（4-7 顶点锯齿/三角/多边形，类似电视雪花/橡皮章颜料缺失），目标覆盖率 **0.5%-1%**。可指定 PRNG seed 复现，支持 `uniform` / `per-char` / `none` 三种模式，颜色可覆盖为 `'#FFFFFF'` 白斑、`'#000000'` 黑墨等实色。
-  **智能文本适配**  超长文本默认**水平拉伸画布**；也可关闭拉伸，按 `shrink`（缩字号）/`clip`（裁剪）/`overflow`（溢出）三种策略处理。
-  **三级字体加载**  远程 URL（自动缓存） 本地字体文件  系统字体族回退。开箱即用支持中英文混排。
-  **字体缓存沙箱**  白名单沙箱 + 系统目录黑名单 + 跨平台文件名规范化，防止误写系统目录。
-  **零依赖 CLI**  单一 `image-lib` 命令含 `stamp` / `crop` / `gen`（端到端抠图+落字一步到位） 三个子命令，无需 `commander` / `yargs`。
-  **5 种导出格式**  `png` / `jpeg` / `webp` / `avif` / `gif`，质量参数与 AvifConfig 严格分发。
-  **双轨构建**  `build:js`（Bun bundler  `dist/main.js` ESM）+ `build:types`（`tsc`  `dist/*.d.ts` 类型声明），消费方完整提示。

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
  // fontSize 默认 = region.height - margins，无需手算
  // speckleMode 默认 'per-char' + speckleColor 'transparent'
  //   在文字上打透明不规则多边形小洞（屏幕雪花质感），覆盖率约 0.5%-1%
  // stretchTextRegion: true（默认） 超长文本水平拉伸画布
  fontColor:      "#FF99A8",
});
writeFileSync("out/final-stamp.png", stamp);
```

> **CLI 一行等价命令：** `image-lib gen --src images/draft.png --text "机密文件" --out out/final-stamp.png`  `gen` 子命令把上述两步库调用合并为一条流水线（crop  stamp），region 自动转发。

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
# （字号自动跟随 region.height，并默认叠加透明屏幕雪花斑驳）
image-lib stamp --bg out/clean.png --text "DRAFT v1.0" \
  --text-region "25,175,248,73" --out out/exact.png

# 长文本  默认拉伸画布
image-lib stamp --bg out/clean.png --text "这是一段超长的草稿文字" \
  --text-region "25,175,248,73" --out out/stretched.png

# 长文本  关闭拉伸 + 自动缩小字号
image-lib stamp --bg out/clean.png --text "这是一段超长的草稿文字" \
  --text-region "25,175,248,73" --no-stretch --overflow shrink --out out/shrunk.png

# 关闭斑驳效果（纯净文字）
image-lib stamp --bg out/clean.png --text "CLEAN" \
  --text-region "25,175,248,73" --no-speckle --out out/clean-text.png

# 不要透明镂空，改用白色实色雪花（橡皮章风格）
image-lib stamp --bg out/clean.png --text "草稿" \
  --text-region "25,175,248,73" --speckle-color "#FFFFFF" --out out/white-speckle.png

# 固定 seed 复现斑驳效果（CI / 视觉回归用）
image-lib stamp --bg out/clean.png --text "草稿" \
  --text-region "25,175,248,73" --speckle-seed 42 --out out/reproducible.png
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
| `--font-size <size>` | `region.height - margins`*（自动）* / 无 region 时 `40` | 字号；支持纯数字（`32`）、`32px`、`24pt`（pt→px 走 96 DPI：`×4/3`） |
| `--font-color <#hex>` | `#FF99A8` | |
| `--no-bold` | 关闭 | 关闭加粗 |
| `--margin <n>` | `20` | 统一四边距（或 `--margin-top/right/bottom/left`） |
| `--speckle-mode <m>` | `per-char` | `none` / `uniform` / `per-char`（屏幕雪花斑驳模式） |
| `--speckle-density <0-1>` | `0.0075` | **目标**打洞覆盖率（推荐 0.0050.01） |
| `--speckle-size <px>` | `1.2` | 多边形基础半径（020）；实际形状为 4-7 顶点不规则多边形 |
| `--speckle-color <css>` | `transparent` | 斑点颜色。默认 `'transparent'` 走 `destination-out` 透明镂空；可传 `#FFFFFF` / `#000000` 等实色 |
| `--speckle-seed <int>` | 随机 | 固定 PRNG 种子（用于 golden file 测试） |
| `--no-speckle` | 关闭 | 等价于 `--speckle-mode none` |
| `--format <fmt>` | `png` | `png` / `jpeg` / `webp` / `avif` / `gif` |
| `--quality <0-100>` |  | JPEG/WebP/GIF 质量 |

### `gen`  端到端流水线（crop + stamp 一步到位）

把 `crop` 和 `stamp` 合并为单次调用：自动定位 `--src` 里的黄色框  抠透明  在抠出来的 region 里精准落字。**无需手动传 `--text-region`**，region 直接复用 crop 的产物。

**gen 专属字体默认值**（库层原本会按 region 高度自动推断）：未指定 `--font-family` / `--font-url` / `--font-file` / `--font-name` 时，gen 默认 `sans-serif`；未指定 `--font-size` 时，gen 默认 `24pt`（= `32px`，96 DPI 下换算）。显式 flag 始终优先。

```bash
# 最简单：源图黄框抠出来，在洞里写 "Approved"  默认 sans-serif + 24pt(32px)
image-lib gen --src images/draft.png --text "Approved" --out out/approved.png

# 同时保留中间抠图产物，方便排查
image-lib gen --src images/draft.png --text "草稿" \
  --out out/zh.png --intermediate out/zh-crop.png

# 自定义字体族 + pt 单位字号（自动换算：30pt  40px）
image-lib gen --src images/draft.png --text "Confidential" --out out/cf.png \
  --font-family 'Georgia, "Times New Roman", serif' --font-size 30pt

# 自定义输出格式 + 关闭斑驳
image-lib gen --src images/draft.png --text "DRAFT" --out out/draft.jpg \
  --format jpeg --quality 90 --font-color "#FF0000" --no-speckle

# 所有 crop / stamp flag 透传，比如自定义框选色 + 固定 seed
image-lib gen --src images/draft.png --text "DONE" --out out/done.png \
  --target-color "0,128,255" --speckle-seed 42
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--src`, `--source <path>` |  | **必填。** 源图路径 |
| `--text <string>` |  | **必填。** 印章文字（1255 字） |
| `--out`, `--output <path>` | `out/gen-stamp.<ext>` | 最终印章输出路径 |
| `--intermediate <path>` |  | 把抠图中间产物落到此路径并保留；不指定时使用系统 tmp 临时文件且渲染完即删 |
| `--keep-intermediate` | 关闭 | 不传 `--intermediate` 时，在 `out/gen-crop-<时间戳>.png` 自动命名并保留 |
| **CROP 透传** |  | `--keep` / `--target-color` / `--target-tolerance` / `--transparent-color` / `--transparent-tolerance` / `--no-transparent` / `--padding` |
| `--font-family <css>` | **`sans-serif`** *(gen 专属)* | 若 `--font-url` / `--font-file` / `--font-name` 任意被指定则不覆盖 |
| `--font-size <size>` | **`24pt` = `32px`** *(gen 专属)* | 支持纯数字（`32`）、`32px`、`24pt`；显式指定后覆盖 region 自动推断 |
| **其它字体 flag** |  | `--font-url` / `--font-file` / `--font-name` / `--font-color` / `--no-bold`（与 `stamp` 一致） |
| **其它 STAMP 透传** |  | 所有 `--margin-*` / `--speckle-*` / `--no-speckle` / `--no-stretch` / `--overflow` 都会传给 stamp。**`--text-region` 会被忽略**  自动取 crop 的 region。 |
| `--format <fmt>` | `png` | `png` / `jpeg` / `webp` / `avif` / `gif`（仅作用于最终输出；中间产物固定 PNG 以保留透明度） |
| `--quality <0-100>` |  | JPEG/WebP/GIF 质量（仅作用于最终输出） |

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
  fontSize?: number;                      // 默认：自动（region.height - margin），无 region 时 40
  fontColor?: string;                     // 默认 '#FF99A8'
  fontBold?: boolean;                     // 默认 true
  fontFamily?: string;                    // CSS font-family
  fontURL?: string;                       // 远程 URL（自动缓存）
  fontFilePath?: string;                  // 本地 .ttf/.otf/.woff/.woff2
  fontName?: string;                      // 注册到 GlobalFonts
  margin?: { top: number; right: number; bottom: number; left: number };
  encodeOptions?: EncodeFormat | EncodeOptions;

  //  矩形模式 
  textRegion?: { x: number; y: number; width: number; height: number };
  stretchTextRegion?: boolean;            // 默认 true（指定 textRegion 时）
  overflowStrategy?: "shrink" | "clip" | "overflow";  // 默认 "shrink"

  //  橡皮章/屏幕雪花斑驳噪声 
  speckleMode?: SpeckleMode;              // 默认 'per-char'（可选 'none' | 'uniform' | 'per-char'）
  speckleDensity?: number;                // 默认 0.0075  目标打洞覆盖率（0-1，推荐 0.005-0.01）
  speckleSize?: number;                   // 默认 1.2px 多边形基础半径（0-20）；算法自动反推斑点数
  speckleColor?: string;                  // 默认 'transparent'（destination-out 透明镂空）；可传 '#FFFFFF'/'#000000' 等实色
  speckleSeed?: number;                   // 固定 PRNG 种子（mulberry32，复现用）
}

type SpeckleMode = 'none' | 'uniform' | 'per-char';
```

**斑驳算法（屏幕雪花多边形 + 目标覆盖率反推）：**

`density` 是"被打掉/被覆盖的文字像素 / 文字像素"的比值，**不是逐像素概率**。算法流程：

1. 扫描 `textRegion` 内匹配 `fontColor`（带容差）的文字像素，得到 `candidates`
2. 反推目标斑点数：`N = round(candidates × density / (π × size² × 抗锯齿补偿))`，补偿系数 `0.12`
3. 按模式抽样 `N` 个位置  `uniform`（全局概率）或 `per-char`（按 x 分桶 ±35% 抖动）
4. 在每个位置绘制**不规则多边形**：4-7 个顶点，角度均匀分布并带 ±30% 抖动，半径在 `[0.3, 1.3] × size`  形成屏幕雪花/电视噪点视感
5. 若 `speckleColor === 'transparent'`（默认）：用 `globalCompositeOperation = 'destination-out'` 把文字像素打成透明（露出背景）；否则用 `source-over` 直接填 `speckleColor` 实色

这意味着 **`speckleSize` 调整不会影响覆盖率**  斑点变大数量自动变少，最终打洞面积始终 ≈ `density × 文字面积`。实测（默认参数 + seed=100）6 个英文样本覆盖率 **0.45%-1.11%**（平均 0.80%，目标 0.75%）。

**两种渲染模式：**

| 条件 | 行为 |
|---|---|
| 不指定 `textRegion` | 原三段拉伸  画布按文本宽度自适应，背景水平拉伸，左右固定 15% 边缘 |
| 指定 `textRegion`，文本不超长 | 画布保持背景图原尺寸，文字在矩形中央绘制 |
| 指定 `textRegion`，文本超长，`stretchTextRegion: true`*（默认）* | 画布水平加宽容纳完整文本，矩形拉伸，左右背景原样保留 |
| 指定 `textRegion`，文本超长，`stretchTextRegion: false` | 按 `overflowStrategy` 处理：<br> `shrink`  二分缩小字号到适配<br> `clip`  保持字号，裁剪到矩形内<br> `overflow`  保持字号，允许溢出 |

### 英文印章样本

下面 6 个常用英文水印既是测试夹具（`tests/data/en-*.png`），也通过 CLI 落盘供肉眼比对（`out/en-*.png`），覆盖率 = (无斑驳的 pink 像素 - 实际 pink 像素) / 无斑驳的 pink 像素：

```bash
# seed=100 可完全复现以下 6 张；覆盖率为文字区域实测
for t in COMP Draft Pending Reject Approved "PEND."; do
  image-lib stamp --bg out/clean.png --text "$t" \
    --text-region "25,175,248,73" --speckle-seed 100 \
    --out "out/en-${t//./_}.png"
done
```

| 样本 | 原 pink 像素 | 打洞后 | 打掉 | 覆盖率 |
|---|---:|---:|---:|---:|
| `COMP`     | 1 360 | 1 352 |  8 | **0.59 %** |
| `Draft`    | 1 007 |   996 | 11 | **1.09 %** |
| `Pending`  | 1 634 | 1 621 | 13 | **0.80 %** |
| `Reject`   | 1 290 | 1 280 | 10 | **0.78 %** |
| `Approved` | 1 808 | 1 788 | 20 | **1.11 %** |
| `PEND.`    | 1 330 | 1 324 |  6 | **0.45 %** |

> 平均覆盖率 **0.80%**，目标 0.75%。区间 0.45%-1.11% 的离散主要来自抽样方差  每张样本只有 5-20 个多边形，单次实测 ±50% 漂移属正常。细笔画字母（Approved/Draft）多边形落点更易跨出有色区，单 dot 有效擦除率略低于粗体。

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
bun test                  # 全部用例（75 个 / 170 断言）
bun run test:image        # 仅抠图测试（14 个）
bun run test:stamp        # 仅印章测试（61 个）
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
- **6 个英文印章样本**（COMP / Draft / Pending / Reject / Approved / PEND.），断言打洞覆盖率
- **字号自动跟随**：3 个用例覆盖 `region.height - margin` 推导、显式 `fontSize` 覆盖、最小 8px clamp
- **斑驳效果**：12 个用例覆盖 `none` / `uniform` / `per-char` 三种模式、透明镂空 vs 实色斑点，density / size / seed 参数 + 边界异常

---

##  脚本

| 命令 | 说明 |
|---|---|
| `bun test` | 跑全部测试（75 个） |
| `bun run test:image` | 仅跑 `cropTransparentBackground` 测试 |
| `bun run test:stamp` | 仅跑 `generateDynamicStamp` 测试 |
| `bun run clean:test` | 清理 `tests/data/`、`src/font_cache/`、`font_cache/` |
| `bun run clean:all`  | `clean:test` + 清理 `out/` 与 `dist/` |
| `bun run build` | 完整构建：`build:js` + `build:types` |
| `bun run build:js` | Bun 打包到 `dist/main.js`（ESM + sourcemap） |
| `bun run build:types` | `tsc -p tsconfig.build.json` 生成 `dist/*.d.ts` 类型声明 |
| `bun run build:logo` | 把 `assets/logo.svg` 栅格化为 PNG（128/256/512） |
| `bun run compile` | 编译当前平台的单文件 CLI |
| `bun run compile:win\|linux\|mac` | 交叉编译各平台 CLI |
| `bun run demo:stamp` | 快速演示：用 `images/draft.png` 生成印章 |
| `bun run demo:crop` | 快速演示：抠取 `images/draft.png` |
| `bun run demo:gen` | 快速演示：端到端抠图 + 在洞里写 `Approved` |

---

##  目录结构

```
image_lib/
 src/
    main.ts                  # 库公共 API 入口
    bin.ts                   # CLI 入口（#!/usr/bin/env bun）
    create_image.ts          # cropTransparentBackground 实现
    create_dynamic_stamp.ts  # generateDynamicStamp + 斑驳 + 字体 + 编码
 tests/
    create_image.test.ts             # 14 个抠图测试
    create_dynamic_stamp.test.ts     # 61 个印章测试（含斑驳 / 自动字号 / 英文样本）
    data/                            # 测试产物（gitignore）
 scripts/
    clean-test.ts            # 清理脚本
    build-logo.ts            # SVG  PNG 栅格化
 assets/
    logo.svg                 # 矢量原图
    logo-{128,256,512}.png   # 栅格输出
 images/draft.png             # 示例输入（测试 / demo 用）
 tsconfig.json                # 编辑器 / 类型检查配置
 tsconfig.build.json          # 仅生成 d.ts 的构建配置（继承上方）
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