import { describe, it, expect, beforeAll } from 'bun:test';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import {
  generateDynamicStamp,
  cropTransparentBackground,
  loadFont,
  normalizeEncodeOptions,
  encodeCanvas,
  getMimeForFormat,
  getExtForFormat,
} from '../src/main';
import { createCanvas } from '@napi-rs/canvas';

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'images', 'draft.png');
const DATA_DIR = path.join(__dirname, 'data');
// 抠图测试产物，作为本测试套件的"背景图"
const CROP_BG = path.join(DATA_DIR, 'cropped-bg.png');

// 开源字体（jsDelivr 镜像 @fontsource，URL 稳定且 woff 体积小）
const NOTO_SANS_SC_URL =
  'https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-sc@5/files/noto-sans-sc-chinese-simplified-700-normal.woff';
const INTER_URL =
  'https://cdn.jsdelivr.net/npm/@fontsource/inter@5/files/inter-latin-700-normal.woff';
const ROBOTO_URL =
  'https://cdn.jsdelivr.net/npm/@fontsource/roboto@5/files/roboto-latin-700-normal.woff';

beforeAll(async () => {
  mkdirSync(DATA_DIR, { recursive: true });
  // 如果上一个测试套件没跑过，先生成 crop 背景，保证本套件自包含可独立运行
  if (!existsSync(CROP_BG)) {
    await cropTransparentBackground({ sourceImgPath: SRC, outputPath: CROP_BG });
  }
});

function isPng(buf: Buffer): boolean {
  return buf.length > 8
    && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
}

function isJpeg(buf: Buffer): boolean {
  return buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
}

//  文字测试样本：中文 / 英文 / 混合 / 边界长度 
const SAMPLES_LANG: Array<{ name: string; text: string }> = [
  { name: '英文单字符',     text: 'D' },
  { name: '英文短词',       text: 'DRAFT' },
  { name: '英文长句',       text: 'CONFIDENTIAL DOCUMENT v2' },
  { name: '中文单字',       text: '草' },
  { name: '中文短词',       text: '草稿' },
  { name: '中文长句',       text: '内部资料请勿外传' },
  { name: '中英混合',       text: '草稿 DRAFT v1.0' },
  { name: '中英数字符号',   text: 'Draft 草稿 #2026-06' },
  { name: '含 emoji 后备', text: 'Draft  草稿' },
];

// 1 / 10 / 50 / 100 / 200 / 255 长度边界（混合中英重复填充）
const SAMPLES_LEN: number[] = [1, 10, 50, 100, 200, 255];

describe('create_dynamic_stamp / encode 工具', () => {
  it('normalizeEncodeOptions 接受字符串简写并默认 png', () => {
    expect(normalizeEncodeOptions().format).toBe('png');
    expect(normalizeEncodeOptions('jpeg').format).toBe('jpeg');
    expect(normalizeEncodeOptions({ format: 'webp', quality: 80 }).format).toBe('webp');
  });

  it('normalizeEncodeOptions 校验非法 format/quality', () => {
    expect(() => normalizeEncodeOptions('jpg' as any)).toThrow(/不支持/);
    expect(() => normalizeEncodeOptions({ format: 'jpeg', quality: 200 })).toThrow(/0-100/);
    expect(() => normalizeEncodeOptions({ format: 'jpeg', quality: -1 })).toThrow(/0-100/);
  });

  it('encodeCanvas 端到端可生成 png / jpeg', async () => {
    const c = createCanvas(20, 20);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#FF99A8';
    ctx.fillRect(0, 0, 20, 20);
    const png = await encodeCanvas(c, 'png');
    const jpg = await encodeCanvas(c, { format: 'jpeg', quality: 80 });
    expect(isPng(png)).toBe(true);
    expect(isJpeg(jpg)).toBe(true);
  });

  it('getMimeForFormat / getExtForFormat 映射正确', () => {
    expect(getMimeForFormat('png')).toBe('image/png');
    expect(getExtForFormat('jpeg')).toBe('.jpg');
    expect(getExtForFormat('webp')).toBe('.webp');
  });
});

describe('create_dynamic_stamp / 字体加载（3 种来源）', () => {
  it('系统字体族（fontFamily）：直接返回 CSS 字体族字符串', async () => {
    const family = await loadFont({
      backgroundPath: CROP_BG,
      text: 'X',
      fontFamily: 'Arial, sans-serif',
    });
    expect(family).toContain('Arial');
  });

  it('本地字体文件（fontFilePath）：注册并返回 fontName', async () => {
    // 复用 NotoSansSC 远程下载的缓存作为"本地字体文件"测试
    const { resolveFontCachePath } = await import('../src/main');
    const cachePath = resolveFontCachePath({ url: NOTO_SANS_SC_URL, fontName: 'NotoSansSC' });
    if (!existsSync(cachePath)) {
      // 先触发一次远程下载产生本地文件
      await loadFont({
        backgroundPath: CROP_BG,
        text: 'X',
        fontURL: NOTO_SANS_SC_URL,
        fontName: 'NotoSansSC',
      });
    }
    const family = await loadFont({
      backgroundPath: CROP_BG,
      text: 'X',
      fontFilePath: cachePath,
      fontName: 'NotoSansSCFromFile',
    });
    expect(family).toBe('NotoSansSCFromFile');
  }, 60_000);

  it('远程字体（fontURL）：下载、缓存、注册 GlobalFonts', async () => {
    const family = await loadFont({
      backgroundPath: CROP_BG,
      text: 'X',
      fontURL: NOTO_SANS_SC_URL,
      fontName: 'NotoSansSC',
    });
    expect(family).toBe('NotoSansSC');
  }, 60_000);
});

describe('create_dynamic_stamp / generateDynamicStamp（以抠图产物为背景）', () => {
  it('使用 crop 产物作背景生成中文印章', async () => {
    const out = path.join(DATA_DIR, 'stamp-on-cropped-bg.png');
    const buf = await generateDynamicStamp({
      backgroundPath: CROP_BG,
      text: '草稿',
      fontFamily: 'Arial, "Microsoft YaHei", sans-serif',
    });
    writeFileSync(out, buf);
    expect(isPng(buf)).toBe(true);
    expect(statSync(out).size).toBeGreaterThan(100);
  });

  describe('中英文及混合文本', () => {
    SAMPLES_LANG.forEach((s, idx) => {
      it(`文本: ${s.name} / "${s.text}"`, async () => {
        const fileSafe = s.name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_');
        const out = path.join(DATA_DIR, `stamp-lang-${String(idx).padStart(2, '0')}-${fileSafe}.png`);
        const buf = await generateDynamicStamp({
          backgroundPath: CROP_BG,
          text: s.text,
          fontURL: NOTO_SANS_SC_URL,
          fontName: 'NotoSansSC',
        });
        writeFileSync(out, buf);
        expect(isPng(buf)).toBe(true);
        expect(statSync(out).size).toBeGreaterThan(100);
      }, 60_000);
    });
  });

  describe('文本长度边界（1 / 10 / 50 / 100 / 200 / 255 字）', () => {
    for (const len of SAMPLES_LEN) {
      it(`长度 ${len} 字的中英混合文本`, async () => {
        // 中英交替循环构造：A中B中... 保证混合
        const base = 'A中B文C混D合';
        let text = '';
        while (text.length < len) text += base;
        text = text.slice(0, len);
        expect(text.length).toBe(len);

        const out = path.join(DATA_DIR, `stamp-len-${String(len).padStart(3, '0')}.png`);
        const buf = await generateDynamicStamp({
          backgroundPath: CROP_BG,
          text,
          fontURL: NOTO_SANS_SC_URL,
          fontName: 'NotoSansSC',
          fontSize: len > 100 ? 24 : 40, // 超长时缩小字号，避免画布过宽
        });
        writeFileSync(out, buf);
        expect(isPng(buf)).toBe(true);
        expect(statSync(out).size).toBeGreaterThan(100);
      }, 120_000);
    }
  });

  describe('多种字体源对比（同一文本）', () => {
    const sampleText = '草稿 DRAFT';
    it('系统字体族', async () => {
      const out = path.join(DATA_DIR, 'stamp-font-system.png');
      const buf = await generateDynamicStamp({
        backgroundPath: CROP_BG,
        text: sampleText,
        fontFamily: 'Arial, "Microsoft YaHei", sans-serif',
      });
      writeFileSync(out, buf);
      expect(isPng(buf)).toBe(true);
    });

    it('远程字体（Noto Sans SC）', async () => {
      const out = path.join(DATA_DIR, 'stamp-font-remote-notosanssc.png');
      const buf = await generateDynamicStamp({
        backgroundPath: CROP_BG,
        text: sampleText,
        fontURL: NOTO_SANS_SC_URL,
        fontName: 'NotoSansSC',
      });
      writeFileSync(out, buf);
      expect(isPng(buf)).toBe(true);
    }, 60_000);

    it('远程字体（Inter，英文）', async () => {
      const out = path.join(DATA_DIR, 'stamp-font-remote-inter.png');
      const buf = await generateDynamicStamp({
        backgroundPath: CROP_BG,
        text: 'DRAFT',
        fontURL: INTER_URL,
        fontName: 'Inter',
      });
      writeFileSync(out, buf);
      expect(isPng(buf)).toBe(true);
    }, 60_000);

    it('远程字体（Roboto，英文）', async () => {
      const out = path.join(DATA_DIR, 'stamp-font-remote-roboto.png');
      const buf = await generateDynamicStamp({
        backgroundPath: CROP_BG,
        text: 'DRAFT',
        fontURL: ROBOTO_URL,
        fontName: 'Roboto',
      });
      writeFileSync(out, buf);
      expect(isPng(buf)).toBe(true);
    }, 60_000);

    it('本地字体文件（从缓存读取）', async () => {
      const { resolveFontCachePath } = await import('../src/main');
      const cachePath = resolveFontCachePath({ url: NOTO_SANS_SC_URL, fontName: 'NotoSansSC' });
      // 确保缓存已存在
      if (!existsSync(cachePath)) {
        await loadFont({
          backgroundPath: CROP_BG,
          text: 'X',
          fontURL: NOTO_SANS_SC_URL,
          fontName: 'NotoSansSC',
        });
      }
      const out = path.join(DATA_DIR, 'stamp-font-local-file.png');
      const buf = await generateDynamicStamp({
        backgroundPath: CROP_BG,
        text: sampleText,
        fontFilePath: cachePath,
        fontName: 'NotoSansSCLocalFile',
      });
      writeFileSync(out, buf);
      expect(isPng(buf)).toBe(true);
    }, 60_000);
  });

  it('支持自定义 fontSize / fontColor / margin', async () => {
    const out = path.join(DATA_DIR, 'stamp-styled.png');
    const buf = await generateDynamicStamp({
      backgroundPath: CROP_BG,
      text: 'STYLED',
      fontSize: 60,
      fontColor: '#FF0000',
      margin: { top: 30, right: 40, bottom: 30, left: 40 },
    });
    writeFileSync(out, buf);
    expect(isPng(buf)).toBe(true);
  });

  it('支持 jpeg 编码 + quality', async () => {
    const out = path.join(DATA_DIR, 'stamp-jpeg-q80.jpg');
    const buf = await generateDynamicStamp({
      backgroundPath: CROP_BG,
      text: 'JPEG',
      encodeOptions: { format: 'jpeg', quality: 80 },
    });
    writeFileSync(out, buf);
    expect(isJpeg(buf)).toBe(true);
  });
});

//  textRegion / 拉伸策略 ——
describe('create_dynamic_stamp / textRegion 文字填充矩形', () => {
  // 抠图产物的 region 在测试集启动时由 beforeAll 生成 CROP_BG，
  // 这里再 crop 一次拿到 region 元数据
  let cropRegion: { x: number; y: number; width: number; height: number };
  let bgWidth = 0;
  let bgHeight = 0;

  beforeAll(async () => {
    const res = await cropTransparentBackground({ sourceImgPath: SRC, outputPath: CROP_BG });
    cropRegion = res.region;
    bgWidth = res.width;
    bgHeight = res.height;
  });

  it('短文本 + textRegion：画布保持背景图原尺寸，文字落在 region 中', async () => {
    const out = path.join(DATA_DIR, 'stamp-region-short.png');
    const buf = await generateDynamicStamp({
      backgroundPath: CROP_BG,
      text: '草', // 1 字必然短于 region
      textRegion: cropRegion,
      fontSize: 40,
      fontURL: NOTO_SANS_SC_URL,
      fontName: 'NotoSansSC',
    });
    writeFileSync(out, buf);
    expect(isPng(buf)).toBe(true);
    // 用 napi-rs 读回尺寸验证
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const img = await loadImage(out);
    expect(img.width).toBe(bgWidth);
    expect(img.height).toBe(bgHeight);
    void createCanvas; // 抑制未读警告
  }, 60_000);

  it('长文本 + 默认 stretch=true：画布水平加宽到容纳完整文本', async () => {
    const out = path.join(DATA_DIR, 'stamp-region-stretched.png');
    const longText = '这是一段超长的草稿文字 DRAFT 2026-06-10';
    const buf = await generateDynamicStamp({
      backgroundPath: CROP_BG,
      text: longText,
      textRegion: cropRegion,
      fontSize: 40,
      fontURL: NOTO_SANS_SC_URL,
      fontName: 'NotoSansSC',
      // stretchTextRegion 默认 true
    });
    writeFileSync(out, buf);
    expect(isPng(buf)).toBe(true);
    const { loadImage } = await import('@napi-rs/canvas');
    const img = await loadImage(out);
    // 拉伸：画布宽度应 > 背景图宽度
    expect(img.width).toBeGreaterThan(bgWidth);
    expect(img.height).toBe(bgHeight);
  }, 60_000);

  it('长文本 + 显式 stretch=true：等同于默认', async () => {
    const longText = '草稿草稿草稿 DRAFT DRAFT';
    const a = await generateDynamicStamp({
      backgroundPath: CROP_BG, text: longText, textRegion: cropRegion, fontSize: 40,
      fontURL: NOTO_SANS_SC_URL, fontName: 'NotoSansSC',
    });
    const b = await generateDynamicStamp({
      backgroundPath: CROP_BG, text: longText, textRegion: cropRegion, fontSize: 40,
      fontURL: NOTO_SANS_SC_URL, fontName: 'NotoSansSC',
      stretchTextRegion: true,
    });
    expect(a.length).toBe(b.length);
  }, 60_000);

  it('长文本 + no-stretch + shrink (默认策略)：画布尺寸不变，字号自动缩小', async () => {
    const out = path.join(DATA_DIR, 'stamp-region-shrink.png');
    const longText = '超长草稿文字测试 DRAFT 2026';
    const buf = await generateDynamicStamp({
      backgroundPath: CROP_BG,
      text: longText,
      textRegion: cropRegion,
      fontSize: 40,
      fontURL: NOTO_SANS_SC_URL,
      fontName: 'NotoSansSC',
      stretchTextRegion: false,
      // overflowStrategy 默认 'shrink'
    });
    writeFileSync(out, buf);
    expect(isPng(buf)).toBe(true);
    const { loadImage } = await import('@napi-rs/canvas');
    const img = await loadImage(out);
    // 画布保持背景图尺寸
    expect(img.width).toBe(bgWidth);
    expect(img.height).toBe(bgHeight);
  }, 60_000);

  it('长文本 + no-stretch + clip：画布不变，文字被裁剪', async () => {
    const out = path.join(DATA_DIR, 'stamp-region-clip.png');
    const buf = await generateDynamicStamp({
      backgroundPath: CROP_BG,
      text: '超长草稿文字测试 DRAFT 2026-06-10',
      textRegion: cropRegion,
      fontSize: 40,
      fontURL: NOTO_SANS_SC_URL,
      fontName: 'NotoSansSC',
      stretchTextRegion: false,
      overflowStrategy: 'clip',
    });
    writeFileSync(out, buf);
    expect(isPng(buf)).toBe(true);
    const { loadImage } = await import('@napi-rs/canvas');
    const img = await loadImage(out);
    expect(img.width).toBe(bgWidth);
    expect(img.height).toBe(bgHeight);
  }, 60_000);

  it('长文本 + no-stretch + overflow：画布不变，允许文字溢出', async () => {
    const out = path.join(DATA_DIR, 'stamp-region-overflow.png');
    const buf = await generateDynamicStamp({
      backgroundPath: CROP_BG,
      text: '超长草稿文字 DRAFT 2026',
      textRegion: cropRegion,
      fontSize: 40,
      fontURL: NOTO_SANS_SC_URL,
      fontName: 'NotoSansSC',
      stretchTextRegion: false,
      overflowStrategy: 'overflow',
    });
    writeFileSync(out, buf);
    expect(isPng(buf)).toBe(true);
    const { loadImage } = await import('@napi-rs/canvas');
    const img = await loadImage(out);
    expect(img.width).toBe(bgWidth);
    expect(img.height).toBe(bgHeight);
  }, 60_000);

  it('完整链路：crop 输出的 region 直接用于 stamp', async () => {
    // 步骤 1：抠图
    const cropOut = path.join(DATA_DIR, 'pipeline-cropped.png');
    const cropRes = await cropTransparentBackground({
      sourceImgPath: SRC,
      outputPath: cropOut,
    });
    expect(cropRes.region.width).toBeGreaterThan(0);

    // 步骤 2：以 crop 产物为背景，region 为文字填充矩形
    const stampOut = path.join(DATA_DIR, 'pipeline-stamp.png');
    const buf = await generateDynamicStamp({
      backgroundPath: cropOut,
      text: '草稿',
      textRegion: cropRes.region,
      fontSize: 40,
      fontURL: NOTO_SANS_SC_URL,
      fontName: 'NotoSansSC',
    });
    writeFileSync(stampOut, buf);
    expect(isPng(buf)).toBe(true);
    const { loadImage } = await import('@napi-rs/canvas');
    const img = await loadImage(stampOut);
    // 短文本：画布保持背景图尺寸
    expect(img.width).toBe(cropRes.width);
    expect(img.height).toBe(cropRes.height);
  }, 60_000);

  it('textRegion 参数校验：负坐标抛错', async () => {
    await expect(generateDynamicStamp({
      backgroundPath: CROP_BG,
      text: 'X',
      textRegion: { x: -1, y: 0, width: 100, height: 50 },
    })).rejects.toThrow(/textRegion/);
  });

  it('textRegion 参数校验：零宽度抛错', async () => {
    await expect(generateDynamicStamp({
      backgroundPath: CROP_BG,
      text: 'X',
      textRegion: { x: 0, y: 0, width: 0, height: 50 },
    })).rejects.toThrow(/width\/height/);
  });

  it('textRegion 参数校验：越界抛错', async () => {
    await expect(generateDynamicStamp({
      backgroundPath: CROP_BG,
      text: 'X',
      textRegion: { x: 0, y: 0, width: 99999, height: 50 },
    })).rejects.toThrow(/超出背景图/);
  });
});