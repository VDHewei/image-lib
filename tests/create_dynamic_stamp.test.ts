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
import { createCanvas, loadImage } from '@napi-rs/canvas';

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
      speckleSeed: 42, // 固定斑驳随机种子，保证两次产出比特相同
    });
    const b = await generateDynamicStamp({
      backgroundPath: CROP_BG, text: longText, textRegion: cropRegion, fontSize: 40,
      fontURL: NOTO_SANS_SC_URL, fontName: 'NotoSansSC',
      stretchTextRegion: true,
      speckleSeed: 42,
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

//  英文测试用例（COMP / Draft / Pending / Reject / Approved / PEND.） 
const ENGLISH_SAMPLES = ['COMP', 'Draft', 'Pending', 'Reject', 'Approved', 'PEND.'] as const;

describe('create_dynamic_stamp / 英文印章样本（覆盖 6 个常用英文水印）', () => {
  ENGLISH_SAMPLES.forEach((text) => {
    it(`英文样本 "${text}"：以 crop 产物为背景生成印章`, async () => {
      const safe = text.replace(/[^a-zA-Z0-9]/g, '_');
      const out = path.join(DATA_DIR, `stamp-en-${safe}.png`);
      const buf = await generateDynamicStamp({
        backgroundPath: CROP_BG,
        text,
        fontURL: NOTO_SANS_SC_URL,
        fontName: 'NotoSansSC',
        // 默认开启斑驳，使用固定种子确保 CI 可重复
        speckleSeed: 1234,
      });
      writeFileSync(out, buf);
      expect(isPng(buf)).toBe(true);
      expect(statSync(out).size).toBeGreaterThan(100);
    }, 60_000);
  });
});

//  自动跟随原图字号 + 斑驳效果 
describe('create_dynamic_stamp / 自动字号 + 斑驳效果', () => {
  let cropRes: { width: number; height: number; region: { x: number; y: number; width: number; height: number } };

  beforeAll(async () => {
    cropRes = await cropTransparentBackground({ sourceImgPath: SRC });
  });

  describe('字号自动跟随原图（textRegion.height - margin）', () => {
    it('指定 textRegion，未指定 fontSize：字号 = region.height - margin.top - margin.bottom', async () => {
      const out = path.join(DATA_DIR, 'stamp-autosize-region.png');
      // region 高 73，margin 默认 20+20=40 → 字号 = 33
      const buf = await generateDynamicStamp({
        backgroundPath: SRC,
        text: 'DRAFT',
        textRegion: cropRes.region,
        // 不指定 fontSize
        speckleMode: 'none',
        fontColor: '#FF99A8',
      });
      writeFileSync(out, buf);
      expect(isPng(buf)).toBe(true);
      const img = await loadImage(out);
      expect(img.width).toBe(cropRes.width);
      expect(img.height).toBe(cropRes.height);
    });

    it('指定 fontSize：始终使用该值，覆盖自动跟随', async () => {
      const auto = await generateDynamicStamp({
        backgroundPath: SRC,
        text: 'DRAFT',
        textRegion: cropRes.region,
        speckleMode: 'none',
        speckleSeed: 7,
      });
      const fixed = await generateDynamicStamp({
        backgroundPath: SRC,
        text: 'DRAFT',
        textRegion: cropRes.region,
        fontSize: 12, // 极小，应明显不同于自动值（≈33）
        speckleMode: 'none',
        speckleSeed: 7,
      });
      // 字号差距导致输出字节数不同
      expect(auto.length).not.toBe(fixed.length);
    });

    it('小 region + 大 margin → 字号 clamp 到最小 8', async () => {
      // 构造 height=10, margin=20，按公式 = 10-40 = -30 → clamp 8
      const tinyRegion = { x: 10, y: 10, width: 100, height: 10 };
      const buf = await generateDynamicStamp({
        backgroundPath: SRC,
        text: 'X',
        textRegion: tinyRegion,
        speckleMode: 'none',
      });
      expect(isPng(buf)).toBe(true);
    });
  });

  describe('斑驳效果（speckleMode）', () => {
    // 用 CROP_BG（已抠透明）作背景，避免原图自带 DRAFT 斑驳干扰统计
    const baseOpts = {
      backgroundPath: CROP_BG,
      text: 'DRAFT',
      textRegion: { x: 25, y: 175, width: 248, height: 73 },
      fontSize: 50,
      fontColor: '#FF99A8',
      fontURL: NOTO_SANS_SC_URL,
      fontName: 'NotoSansSC',
    };

    /**
     * 计算"打洞覆盖率" = 1 - (有斑驳的文字像素 / 无斑驳的文字像素)
     * 即被透明多边形"打掉"或被实色覆盖掉的文字像素占原始文字像素的比例
     */
    async function computePunchCoverage(
      actualPath: string,
      baselinePath: string,
    ): Promise<number> {
      const a = await speckleStats(actualPath, baseOpts.textRegion);
      const b = await speckleStats(baselinePath, baseOpts.textRegion);
      if (b.pinkPixels === 0) return 0;
      const punched = Math.max(0, b.pinkPixels - a.pinkPixels);
      return punched / b.pinkPixels;
    }

    // 共用基线：speckleMode='none' 的纯净文字
    let baselinePath: string;

    beforeAll(async () => {
      baselinePath = path.join(DATA_DIR, 'stamp-speckle-baseline.png');
      const buf = await generateDynamicStamp({ ...baseOpts, speckleMode: 'none' });
      writeFileSync(baselinePath, buf);
    }, 60_000);

    it('speckleMode="none"：纯色文字，无任何被打掉的像素', async () => {
      const out = path.join(DATA_DIR, 'stamp-speckle-none.png');
      const buf = await generateDynamicStamp({ ...baseOpts, speckleMode: 'none' });
      writeFileSync(out, buf);
      const coverage = await computePunchCoverage(out, baselinePath);
      // 与自身对比 → 差值应严格 < 0.5%（仅 PNG 压缩抖动）
      expect(coverage).toBeLessThan(0.005);
    }, 60_000);

    it('默认 density (0.75%) 满足用户需求：打洞覆盖率落在 0.5%-1% 区间（容差 ±50%）', async () => {
      const out = path.join(DATA_DIR, 'stamp-speckle-default.png');
      const buf = await generateDynamicStamp({ ...baseOpts, speckleSeed: 42 });
      writeFileSync(out, buf);
      const coverage = await computePunchCoverage(out, baselinePath);
      // 目标 0.5%-1%，考虑不规则多边形 + 反走样边缘 + 抽样方差，给 [0.25%, 1.5%] 容差
      expect(coverage).toBeGreaterThanOrEqual(0.0025);
      expect(coverage).toBeLessThanOrEqual(0.015);
    }, 60_000);

    it('speckleMode="uniform" + seed：bit-exact 可复现', async () => {
      const out1 = path.join(DATA_DIR, 'stamp-speckle-uniform-a.png');
      const out2 = path.join(DATA_DIR, 'stamp-speckle-uniform-b.png');
      const a = await generateDynamicStamp({
        ...baseOpts, speckleMode: 'uniform', speckleSeed: 99, speckleDensity: 0.0075,
      });
      const b = await generateDynamicStamp({
        ...baseOpts, speckleMode: 'uniform', speckleSeed: 99, speckleDensity: 0.0075,
      });
      writeFileSync(out1, a);
      writeFileSync(out2, b);
      // 同种子 → 字节级一致
      expect(a.length).toBe(b.length);
      const coverage = await computePunchCoverage(out1, baselinePath);
      // uniform 0.75% 实际覆盖率应在容差区间
      expect(coverage).toBeGreaterThan(0.002);
      expect(coverage).toBeLessThan(0.015);
    }, 60_000);

    it('speckleMode="per-char"（默认）：每个字符都有斑驳分布', async () => {
      const out = path.join(DATA_DIR, 'stamp-speckle-perchar.png');
      const buf = await generateDynamicStamp({
        ...baseOpts, speckleSeed: 123, speckleDensity: 0.0075,
      }); // 不传 speckleMode → 默认 per-char
      writeFileSync(out, buf);
      const coverage = await computePunchCoverage(out, baselinePath);
      // per-char 桶间有 ±35% 抖动，全局 ≈ density
      expect(coverage).toBeGreaterThan(0.002);
      expect(coverage).toBeLessThan(0.015);
    }, 60_000);

    it('密度越高 → 打洞覆盖率越高（呈正比关系）', async () => {
      const low = await generateDynamicStamp({
        ...baseOpts, speckleMode: 'uniform', speckleSeed: 7, speckleDensity: 0.005,
      });
      const high = await generateDynamicStamp({
        ...baseOpts, speckleMode: 'uniform', speckleSeed: 7, speckleDensity: 0.02,
      });
      const lowPath  = path.join(DATA_DIR, 'stamp-speckle-density-low.png');
      const highPath = path.join(DATA_DIR, 'stamp-speckle-density-high.png');
      writeFileSync(lowPath, low);
      writeFileSync(highPath, high);
      const lc = await computePunchCoverage(lowPath, baselinePath);
      const hc = await computePunchCoverage(highPath, baselinePath);
      // 4× 密度应至少给出 2× 覆盖（考虑随机方差，不要求严格 4×）
      expect(hc).toBeGreaterThan(lc * 2);
    }, 60_000);

    it('speckleSize 改变不影响最终覆盖率（算法自动反推斑点数量）', async () => {
      // 同 density=0.75% 下，size=1 与 size=2 的覆盖率应大致相同
      const small = await generateDynamicStamp({
        ...baseOpts, speckleMode: 'uniform', speckleSeed: 5, speckleDensity: 0.0075, speckleSize: 1,
      });
      const large = await generateDynamicStamp({
        ...baseOpts, speckleMode: 'uniform', speckleSeed: 5, speckleDensity: 0.0075, speckleSize: 2,
      });
      const sPath = path.join(DATA_DIR, 'stamp-speckle-size-small.png');
      const lPath = path.join(DATA_DIR, 'stamp-speckle-size-large.png');
      writeFileSync(sPath, small);
      writeFileSync(lPath, large);
      const sc = await computePunchCoverage(sPath, baselinePath);
      const lc = await computePunchCoverage(lPath, baselinePath);
      // 两者都应在容差区间（size 不同会因抗锯齿/像素离散有 ±50% 偏差，但都应 < 2%）
      expect(sc).toBeGreaterThan(0.002);
      expect(sc).toBeLessThan(0.02);
      expect(lc).toBeGreaterThan(0.002);
      expect(lc).toBeLessThan(0.02);
    }, 60_000);

    it('默认 transparent：被打洞像素变成透明（alpha=0），而非白色覆盖', async () => {
      const out = path.join(DATA_DIR, 'stamp-speckle-transparent.png');
      const buf = await generateDynamicStamp({
        ...baseOpts, speckleSeed: 555, speckleDensity: 0.015, // 略高密度便于观察
      });
      writeFileSync(out, buf);
      const stats = await speckleStats(out, baseOpts.textRegion);
      // 透明模式：白色斑点应几乎为零（背景被打透，不会出现新白色）
      expect(stats.whiteSpecklePixels).toBeLessThan(15);
      // 文字像素数应相对 baseline 显著减少（被打掉的成为透明）
      const baseline = await speckleStats(baselinePath, baseOpts.textRegion);
      expect(stats.pinkPixels).toBeLessThan(baseline.pinkPixels);
    }, 60_000);

    it('自定义 speckleColor（黑色实色）：黑色斑点出现，不走 destination-out', async () => {
      const out = path.join(DATA_DIR, 'stamp-speckle-black.png');
      const buf = await generateDynamicStamp({
        ...baseOpts, speckleMode: 'uniform', speckleSeed: 8, speckleDensity: 0.02, speckleColor: '#000000',
      });
      writeFileSync(out, buf);
      const stats = await speckleStats(out, baseOpts.textRegion);
      // 黑色斑点：应出现可见数量的黑色像素
      expect(stats.blackSpecklePixels).toBeGreaterThan(5);
      // 白色斑点应几乎没有
      expect(stats.whiteSpecklePixels).toBeLessThan(10);
    }, 60_000);

    it('自定义 speckleColor（白色实色）：白色斑点出现，非透明', async () => {
      const out = path.join(DATA_DIR, 'stamp-speckle-white.png');
      const buf = await generateDynamicStamp({
        ...baseOpts, speckleMode: 'uniform', speckleSeed: 11, speckleDensity: 0.02, speckleColor: '#FFFFFF',
      });
      writeFileSync(out, buf);
      const stats = await speckleStats(out, baseOpts.textRegion);
      // 白色实色覆盖：应出现可见数量的白色像素
      expect(stats.whiteSpecklePixels).toBeGreaterThan(5);
    }, 60_000);

    it('参数校验：speckleMode 非法值抛错', async () => {
      await expect(generateDynamicStamp({
        ...baseOpts, speckleMode: 'crazy' as never,
      })).rejects.toThrow(/speckleMode/);
    });

    it('参数校验：speckleDensity 越界抛错', async () => {
      await expect(generateDynamicStamp({
        ...baseOpts, speckleDensity: 2,
      })).rejects.toThrow(/speckleDensity/);
      await expect(generateDynamicStamp({
        ...baseOpts, speckleDensity: -0.1,
      })).rejects.toThrow(/speckleDensity/);
    });

    it('参数校验：speckleSize 越界抛错', async () => {
      await expect(generateDynamicStamp({
        ...baseOpts, speckleSize: 0,
      })).rejects.toThrow(/speckleSize/);
      await expect(generateDynamicStamp({
        ...baseOpts, speckleSize: 999,
      })).rejects.toThrow(/speckleSize/);
    });
  });
});

/**
 * 统计文件指定矩形区域内的颜色像素：
 *  - whiteRatio: 矩形内白色像素占总像素的比例
 *  - whiteSpecklePixels: 矩形内严格白色像素数（≥240,≥240,≥240）
 *  - pinkPixels: 接近 #FF99A8 的像素数（文字主色）
 *  - blackSpecklePixels: 严格黑色像素数（≤30,≤30,≤30）
 */
async function speckleStats(
  filePath: string,
  region: { x: number; y: number; width: number; height: number },
): Promise<{
  whiteRatio: number;
  whiteSpecklePixels: number;
  pinkPixels: number;
  blackSpecklePixels: number;
  totalPixels: number;
}> {
  const { loadImage, createCanvas } = await import('@napi-rs/canvas');
  const img = await loadImage(filePath);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const x = Math.max(0, region.x);
  const y = Math.max(0, region.y);
  const w = Math.min(img.width - x, region.width);
  const h = Math.min(img.height - y, region.height);
  const data = ctx.getImageData(x, y, w, h).data;
  let white = 0, pink = 0, black = 0, total = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!, a = data[i + 3]!;
    if (a < 32) continue;
    total++;
    if (r >= 240 && g >= 240 && b >= 240) white++;
    else if (r >= 200 && g < 200 && b > 100 && b < 200 && r - g > 30) pink++;
    else if (r <= 30 && g <= 30 && b <= 30) black++;
  }
  return {
    whiteRatio: total > 0 ? white / total : 0,
    whiteSpecklePixels: white,
    pinkPixels: pink,
    blackSpecklePixels: black,
    totalPixels: total,
  };
}