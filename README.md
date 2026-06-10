<div align="center">

<img src="./assets/logo-256.png" alt="image_lib logo" width="180" />

# image_lib

**Lightweight image processing for Bun & Node  dynamic text stamps + color-based transparent cropping, powered by [@napi-rs/canvas](https://github.com/Brooooooklyn/canvas).**

[![Bun](https://img.shields.io/badge/runtime-Bun%20%E2%89%A51.0-fbf0df?logo=bun)](https://bun.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Tests](https://img.shields.io/badge/tests-54%20passing-brightgreen)](#testing)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](#license)

[English](./README.md)  [简体中文](./README.zh-CN.md)

</div>

---

##  Features

-  **Color-based cropping**  Locate a bounding box by target color (default yellow), keep **inside** *or* **outside** the box, with optional white-background transparency.
-  **Region-aware stamp**  `cropTransparentBackground` returns the punched region, which feeds straight into `generateDynamicStamp` so text lands exactly inside the "hole".
-  **Smart text fitting**  Long text either **stretches** the canvas horizontally (default) or stays put with `shrink` / `clip` / `overflow` strategies.
-  **3-tier font loading**  Remote URL (cached)  local file  system font family fallback. CJK + Latin out of the box.
-  **Security-first font cache**  Whitelisted sandbox + blacklist for system directories; cross-platform safe filename normalization.
-  **Zero-bloat CLI**  Single `image-lib` binary with `stamp` and `crop` subcommands. No `commander`, no `yargs`.
-  **5 encode formats**  `png` / `jpeg` / `webp` / `avif` / `gif` with proper quality/AvifConfig dispatch.

---

##  Installation

```bash
# With Bun (recommended)
bun add image_lib

# With pnpm / npm / yarn
pnpm add image_lib
npm  install image_lib
yarn add image_lib
```

> Requires **Bun  1.0** or **Node  18** (with `@napi-rs/canvas` prebuilt binaries).

---

##  Quick Start

```ts
import {
  cropTransparentBackground,
  generateDynamicStamp,
} from "image_lib";
import { writeFileSync } from "fs";

// 1. Crop: locate the yellow box and punch it out, also remove white background
const { buffer, region } = await cropTransparentBackground({
  sourceImgPath: "images/draft.png",
  outputPath:    "out/clean-bg.png",
  // keepRegion: "outside" (default)  keep area outside the yellow box
  // transparentColor defaults to white {r:255,g:255,b:255}
});

console.log(`Punched region: ${region.width}x${region.height} at (${region.x},${region.y})`);

// 2. Stamp: render text precisely inside the punched region
const stamp = await generateDynamicStamp({
  backgroundPath: "out/clean-bg.png",
  text:           "CONFIDENTIAL",
  textRegion:     region,           //  perfect alignment, zero math
  // stretchTextRegion: true (default)  long text widens the canvas
  fontColor:      "#FF99A8",
});
writeFileSync("out/final-stamp.png", stamp);
```

---

##  CLI

```bash
# After install
image-lib --help
image-lib stamp --help
image-lib crop  --help

# Or via Bun directly (from source)
bun run src/bin.ts <command> ...
```

### `crop`  color-based cropping

```bash
# Default: keep outside the yellow box, remove white background  outputs source-sized PNG
image-lib crop --src images/draft.png --out out/clean.png

# Output includes the region coordinates, ready to paste into `stamp --text-region`:
#   region: x=25 y=175 w=248 h=73
#   Use as stamp --text-region: "25,175,248,73"

# Keep inside the box, cropped to box size
image-lib crop --src images/draft.png --out out/inside.png --keep inside

# Disable white-background transparency, preserve all original colors
image-lib crop --src images/draft.png --out out/no-trans.png --no-transparent
```

| Flag | Default | Description |
|---|---|---|
| `--src`, `--source <path>` |  | **Required.** Source image path |
| `--out`, `--output <path>` | `out/clean-bg.<ext>` | Output path (PNG recommended) |
| `--keep <outside\|inside>` | `outside` | Which side of the bounding box to keep |
| `--target-color <r,g,b>` | `255,215,0` | Color used to locate the bounding box |
| `--target-tolerance <n>` | `80` | Euclidean color distance tolerance |
| `--transparent-color <r,g,b>` | `255,255,255` | Color to make transparent (within kept area) |
| `--transparent-tolerance <n>` | `40` | Tolerance for transparent color |
| `--no-transparent` | off | Disable color-based transparency |
| `--padding <px>` | `0` | `outside`: shrink hole inward  `inside`: expand crop outward |
| `--format <fmt>` | `png` | `png` / `jpeg` / `webp` / `avif` / `gif` |
| `--quality <0-100>` |  | JPEG/WebP/GIF quality |

### `stamp`  dynamic text stamp

```bash
# Auto-width canvas (no textRegion)  original three-segment stretch behavior
image-lib stamp --bg images/draft.png --text "草稿" --out out/zh.png

# Region-aware: text precisely fills the punched area
image-lib stamp --bg out/clean.png --text "DRAFT v1.0" \
  --text-region "25,175,248,73" --out out/exact.png

# Long text  default stretches the canvas wider
image-lib stamp --bg out/clean.png --text "This is a very long draft text" \
  --text-region "25,175,248,73" --out out/stretched.png

# Long text without stretching  font size auto-shrinks
image-lib stamp --bg out/clean.png --text "This is a very long draft text" \
  --text-region "25,175,248,73" --no-stretch --overflow shrink --out out/shrunk.png
```

| Flag | Default | Description |
|---|---|---|
| `--bg`, `--background <path>` |  | **Required.** Background image |
| `--text <string>` |  | **Required.** Stamp text (1255 chars) |
| `--out`, `--output <path>` | `out/stamp.<ext>` | Output path |
| `--text-region <x,y,w,h>` |  | Region where text is rendered (in pixels) |
| `--no-stretch` | off | Keep canvas size when text overflows region |
| `--overflow <strategy>` | `shrink` | `shrink` / `clip` / `overflow` (only when `--no-stretch`) |
| `--font-url <url>` |  | Remote font URL (highest priority, auto-cached) |
| `--font-file <path>` |  | Local font file path (`.ttf` / `.otf` / `.woff` / `.woff2`) |
| `--font-family <css>` | system fallback | CSS font-family string |
| `--font-name <name>` | `StampFont` | Name registered to `GlobalFonts` |
| `--font-size <px>` | `40` | |
| `--font-color <#hex>` | `#FF99A8` | |
| `--no-bold` | off | Disable bold |
| `--margin <n>` | `20` | Uniform 4-side margin (or `--margin-top/right/bottom/left`) |
| `--format <fmt>` | `png` | `png` / `jpeg` / `webp` / `avif` / `gif` |
| `--quality <0-100>` |  | JPEG/WebP/GIF quality |

---

##  Library API

### `cropTransparentBackground(options): Promise<CropResult>`

Color-based cropping with two retention modes.

```ts
interface CropOptions {
  sourceImgPath: string;                  // required
  outputPath?: string;                    // also writes to disk if provided
  keepRegion?: "outside" | "inside";      // default: "outside"
  targetColor?: RGB;                      // default: yellow {r:255,g:215,b:0}
  targetTolerance?: number;               // default: 80
  transparentColor?: RGB | null;          // default: white. Pass null to disable.
  transparentTolerance?: number;          // default: 40
  padding?: number;                       // default: 0
  encodeOptions?: EncodeFormat | EncodeOptions;
}

interface CropResult {
  buffer: Buffer;                         // encoded image
  region: { x: number; y: number; width: number; height: number };
  width:  number;                         // output canvas width
  height: number;                         // output canvas height
}
```

| Mode | Output size | `region` describes | `padding` semantics |
|---|---|---|---|
| `outside` (default) | source dimensions | The transparent "hole" in the canvas | shrinks the hole **inward** (preserves the colored border) |
| `inside` | bounding box dimensions | Always `{x:0, y:0, w:canvasW, h:canvasH}` | expands the crop **outward** |

### `generateDynamicStamp(options): Promise<Buffer>`

```ts
interface GenerateStampOptions {
  backgroundPath: string;                 // required
  text: string;                           // required (1255 chars)
  fontSize?: number;                      // default: 40
  fontColor?: string;                     // default: '#FF99A8'
  fontBold?: boolean;                     // default: true
  fontFamily?: string;                    // CSS font-family
  fontURL?: string;                       // remote URL (auto-cached)
  fontFilePath?: string;                  // local .ttf/.otf/.woff/.woff2
  fontName?: string;                      // registered to GlobalFonts
  margin?: { top: number; right: number; bottom: number; left: number };
  encodeOptions?: EncodeFormat | EncodeOptions;

  //  Region mode (new) 
  textRegion?: { x: number; y: number; width: number; height: number };
  stretchTextRegion?: boolean;            // default: true (when textRegion is set)
  overflowStrategy?: "shrink" | "clip" | "overflow";  // default: "shrink"
}
```

**Two rendering modes:**

| Condition | Behavior |
|---|---|
| No `textRegion` | Original three-segment stretch  canvas auto-widens to fit text, background stretches horizontally with fixed 15% left/right edges. |
| `textRegion` set, text fits | Canvas keeps background dimensions, text centered inside the region. |
| `textRegion` set, text overflows, `stretchTextRegion: true` *(default)* | Canvas widens horizontally to fit, region stretches, left/right background preserved. |
| `textRegion` set, text overflows, `stretchTextRegion: false` | Apply `overflowStrategy`:<br> `shrink`  binary-search font size down<br> `clip`  render full size, clip to region<br> `overflow`  render full size, allow overflow |

### Font loading (3-tier fallback)

`loadFont(options)` tries each source in order, returning the resolved font-family string:

1. **`fontURL`**  Download to `font_cache/`, register to `GlobalFonts`. Re-runs are cache-hits.
2. **`fontFilePath`**  `GlobalFonts.registerFromPath`, no download.
3. **`fontFamily`**  Pass-through CSS string, relies on system fonts.

```ts
// Recommended: jsDelivr mirror of @fontsource (small woff, stable URLs)
const NOTO_SANS_SC =
  "https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-sc@5/files/noto-sans-sc-chinese-simplified-700-normal.woff";

await generateDynamicStamp({
  backgroundPath: "out/clean-bg.png",
  text:           "草稿 DRAFT",
  fontURL:        NOTO_SANS_SC,
  fontName:       "NotoSansSC",
});
```

### Encoding helpers

```ts
import {
  encodeCanvas,
  normalizeEncodeOptions,
  getMimeForFormat,
  getExtForFormat,
} from "image_lib";

// All wired into canvas.encode() overloads correctly
await encodeCanvas(canvas, "png");
await encodeCanvas(canvas, { format: "jpeg", quality: 80 });
await encodeCanvas(canvas, { format: "avif", avifConfig: { speed: 10 } });

getMimeForFormat("webp");  //  "image/webp"
getExtForFormat("jpeg");   //  ".jpg"
```

---

##  Testing

```bash
bun test                  # all suites (54 tests)
bun run test:image        # crop tests only (14)
bun run test:stamp        # stamp tests only (40)
bun run test:watch        # watch mode
```

Test outputs land in `tests/data/` (auto-created). Use `bun run clean:test` to wipe.

**Coverage highlights:**
- Both `outside` / `inside` crop modes with padding, custom colors, edge cases
- Default white-background transparency on/off
- `textRegion` rendering: stretch / no-stretch + shrink / clip / overflow
- End-to-end chain: `crop`  use returned `region` in `stamp`
- 9 language samples (English, Chinese, mixed, emoji fallback)
- 6 length boundaries (1, 10, 50, 100, 200, 255 chars)
- 3 font sources (remote with cache, local file, system family)
- 5 encode formats with quality/AvifConfig

---

##  Scripts

| Script | Description |
|---|---|
| `bun test` | Run full test suite |
| `bun run test:image` | Run `cropTransparentBackground` tests only |
| `bun run test:stamp` | Run `generateDynamicStamp` tests only |
| `bun run clean:test` | Remove `tests/data/`, `src/font_cache/`, `font_cache/` |
| `bun run clean:all`  | `clean:test` + remove `out/` and `dist/` |
| `bun run build` | Bundle library to `dist/` (ESM, with sourcemap) |
| `bun run build:logo` | Rasterize `assets/logo.svg`  PNG (128/256/512) |
| `bun run compile` | Compile single-binary CLI for current OS |
| `bun run compile:win\|linux\|mac` | Cross-compile CLI for each platform |
| `bun run demo:stamp` | Quick demo: generate a stamp from `images/draft.png` |
| `bun run demo:crop` | Quick demo: crop `images/draft.png` |

---

##  Project Layout

```
image_lib/
 src/
    main.ts                  # Public API entry (lib export)
    bin.ts                   # CLI entry (#!/usr/bin/env bun)
    create_image.ts          # cropTransparentBackground impl
    create_dynamic_stamp.ts  # generateDynamicStamp + font + encode
 tests/
    create_image.test.ts     # 14 crop tests
    create_dynamic_stamp.test.ts  # 40 stamp tests
    data/                    # generated outputs (gitignored)
 scripts/
    clean-test.ts            # cleanup script
    build-logo.ts            # SVG  PNG rasterizer
 assets/
    logo.svg                 # source vector
    logo-{128,256,512}.png   # rasterized
 images/draft.png             # sample input (used in tests/demos)
 package.json
```

---

##  Cross-platform Notes

- **Linux/Docker:** install fontconfig + a fallback font (`fonts-noto-cjk` for Chinese) to ensure system-font path works.
- **Windows:** Uses `C:\Windows\Fonts` automatically. Font cache lands in `src/font_cache/` (whitelisted).
- **Custom cache root:** set `FONT_CACHE_ALLOWED_ROOTS` env var (multi-path with `;` on Windows, `:` on POSIX) to allow extra sandbox roots.

---

##  License

[MIT](./LICENSE)  2026

---

<div align="center">

Made with  &   Star us if this helped!

</div>