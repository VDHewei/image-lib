import { describe, it, expect, beforeAll } from 'bun:test';
import { existsSync, mkdirSync, statSync, readFileSync } from 'fs';
import path from 'path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { cropTransparentBackground } from '../src/main';

const SRC = path.join(__dirname, '..', 'images', 'draft.png');
const DATA_DIR = path.join(__dirname, 'data');
// 默认 outside 模式产物：作为印章背景图复用（带"洞"且白底已透明的源图）
const CROP_OUTSIDE = path.join(DATA_DIR, 'cropped-bg.png');
// inside 模式产物
const CROP_INSIDE = path.join(DATA_DIR, 'cropped-bg-inside.png');

beforeAll(() => {
  mkdirSync(DATA_DIR, { recursive: true });
});

function isPng(buf: Buffer): boolean {
  return buf.length > 8
    && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47
    && buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A;
}

async function pixelStats(filePath: string): Promise<{
  width: number;
  height: number;
  transparent: number;
  opaque: number;
  total: number;
}> {
  const img = await loadImage(filePath);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, img.width, img.height).data;
  let transparent = 0, opaque = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] === 0) transparent++;
    else opaque++;
  }
  return { width: img.width, height: img.height, transparent, opaque, total: transparent + opaque };
}

describe('create_image / cropTransparentBackground', () => {
  it('源图存在', () => {
    expect(existsSync(SRC)).toBe(true);
  });

  //  outside 模式（默认） 
  describe('outside 模式（默认，保留框外）', () => {
    it('默认参数：输出 = 源图尺寸，框内整块透明，框外白底也透明', async () => {
      const res = await cropTransparentBackground({
        sourceImgPath: SRC,
        outputPath: CROP_OUTSIDE,
        // 不传 keepRegion 验证默认值
      });
      expect(isPng(res.buffer)).toBe(true);
      expect(existsSync(CROP_OUTSIDE)).toBe(true);

      // 返回值结构完整
      expect(res.width).toBeGreaterThan(0);
      expect(res.height).toBeGreaterThan(0);
      expect(res.region.width).toBeGreaterThan(0);
      expect(res.region.height).toBeGreaterThan(0);
      expect(res.region.x).toBeGreaterThanOrEqual(0);
      expect(res.region.y).toBeGreaterThanOrEqual(0);

      const src = await pixelStats(SRC);
      const out = await pixelStats(CROP_OUTSIDE);
      // 输出尺寸应等于源图，且与返回的 width/height 一致
      expect(out.width).toBe(src.width);
      expect(out.height).toBe(src.height);
      expect(res.width).toBe(src.width);
      expect(res.height).toBe(src.height);
      // 新默认抠白：透明像素应远多于源图（框内+框外白底全透明）
      expect(out.transparent).toBeGreaterThan(out.total * 0.4);
    });

    it('显式 keepRegion="outside" 等价于默认', async () => {
      const a = await cropTransparentBackground({ sourceImgPath: SRC });
      const b = await cropTransparentBackground({ sourceImgPath: SRC, keepRegion: 'outside' });
      expect(a.buffer.length).toBe(b.buffer.length);
      expect(a.region).toEqual(b.region);
    });

    it('padding 在 outside 模式下向内收缩透明区域', async () => {
      const noPad = await cropTransparentBackground({ sourceImgPath: SRC, keepRegion: 'outside' });
      const withPad = await cropTransparentBackground({
        sourceImgPath: SRC,
        keepRegion: 'outside',
        padding: 10,
      });
      // padding 收缩 -> region 变小
      expect(withPad.region.width).toBeLessThan(noPad.region.width);
      expect(withPad.region.height).toBeLessThan(noPad.region.height);
      // 写入临时文件比像素
      const tmp1 = path.join(DATA_DIR, '_tmp-outside-nopad.png');
      const tmp2 = path.join(DATA_DIR, '_tmp-outside-pad10.png');
      Bun.write(tmp1, noPad.buffer);
      Bun.write(tmp2, withPad.buffer);
      await new Promise(r => setTimeout(r, 50));
      const s1 = await pixelStats(tmp1);
      const s2 = await pixelStats(tmp2);
      // padding 收缩  透明像素更少（保留更多内容）
      expect(s2.transparent).toBeLessThan(s1.transparent);
    });

    it('outside 模式可显式关闭透明色（transparentColor=null）保留所有原色', async () => {
      const out = path.join(DATA_DIR, 'cropped-bg-outside-no-trans.png');
      const res = await cropTransparentBackground({
        sourceImgPath: SRC,
        outputPath: out,
        keepRegion: 'outside',
        transparentColor: null,
      });
      expect(isPng(res.buffer)).toBe(true);
      const baseline = await pixelStats(CROP_OUTSIDE);
      const stats = await pixelStats(out);
      // 关闭白色透明化  透明像素更少（仅"洞"内透明）
      expect(stats.transparent).toBeLessThan(baseline.transparent);
    });

    it('outside 模式 region 描述透明洞的位置（绝对像素坐标）', async () => {
      const res = await cropTransparentBackground({ sourceImgPath: SRC });
      // region 应完全落在画布内
      expect(res.region.x + res.region.width).toBeLessThanOrEqual(res.width);
      expect(res.region.y + res.region.height).toBeLessThanOrEqual(res.height);
    });
  });

  //  inside 模式 
  describe('inside 模式（裁剪保留框内）', () => {
    it('裁剪到 targetColor 矩形 + 默认抠白底', async () => {
      const res = await cropTransparentBackground({
        sourceImgPath: SRC,
        outputPath: CROP_INSIDE,
        keepRegion: 'inside',
      });
      expect(isPng(res.buffer)).toBe(true);

      const src = await pixelStats(SRC);
      const out = await pixelStats(CROP_INSIDE);
      // 裁剪到小矩形：尺寸应远小于源图
      expect(out.width).toBeLessThan(src.width);
      expect(out.height).toBeLessThan(src.height);
      // inside 模式 region = 整张输出画布
      expect(res.region.x).toBe(0);
      expect(res.region.y).toBe(0);
      expect(res.region.width).toBe(res.width);
      expect(res.region.height).toBe(res.height);
      // 默认抠白：应有透明像素
      expect(out.transparent).toBeGreaterThan(100);
      expect(out.opaque).toBeGreaterThan(100);
    });

    it('inside + padding 外扩裁剪边界', async () => {
      const noPad = await pixelStats(CROP_INSIDE);
      const out = path.join(DATA_DIR, 'cropped-bg-inside-padding-20.png');
      const res = await cropTransparentBackground({
        sourceImgPath: SRC,
        outputPath: out,
        keepRegion: 'inside',
        padding: 20,
      });
      const padded = await pixelStats(out);
      // 外扩 20  宽高至少各加 30+
      expect(padded.width).toBeGreaterThan(noPad.width + 30);
      expect(padded.height).toBeGreaterThan(noPad.height + 30);
      expect(res.width).toBe(padded.width);
      expect(res.height).toBe(padded.height);
    });

    it('inside 模式显式关闭白色透明化（transparentColor=null）', async () => {
      const out = path.join(DATA_DIR, 'cropped-bg-inside-no-transparent.png');
      const res = await cropTransparentBackground({
        sourceImgPath: SRC,
        outputPath: out,
        keepRegion: 'inside',
        transparentColor: null,
      });
      expect(isPng(res.buffer)).toBe(true);
      const stats = await pixelStats(out);
      // 关闭后应几乎不透明（仅极少透明，如 PNG 抗锯齿）
      expect(stats.opaque).toBeGreaterThan(stats.total * 0.95);
    });

    it('inside + 自定义 transparentColor（抠粉色文字而非白底）', async () => {
      const out = path.join(DATA_DIR, 'cropped-bg-inside-pink-out.png');
      const res = await cropTransparentBackground({
        sourceImgPath: SRC,
        outputPath: out,
        keepRegion: 'inside',
        transparentColor: { r: 255, g: 100, b: 130 },
        transparentTolerance: 80,
      });
      expect(isPng(res.buffer)).toBe(true);
    });
  });

  //  异常路径 
  describe('异常处理', () => {
    it('未找到目标颜色时抛错', async () => {
      await expect(cropTransparentBackground({
        sourceImgPath: SRC,
        targetColor: { r: 0, g: 255, b: 0 },
        targetTolerance: 5,
      })).rejects.toThrow(/未在源图中找到目标颜色/);
    });

    it('keepRegion 非法值抛错', async () => {
      await expect(cropTransparentBackground({
        sourceImgPath: SRC,
        keepRegion: 'middle' as never,
      })).rejects.toThrow(/keepRegion/);
    });

    it('其他参数校验', async () => {
      await expect(cropTransparentBackground({ sourceImgPath: '' }))
        .rejects.toThrow(/非空字符串/);
      await expect(cropTransparentBackground({ sourceImgPath: 'no-such.png' }))
        .rejects.toThrow(/不存在/);
      await expect(cropTransparentBackground({
        sourceImgPath: SRC,
        targetColor: { r: 300, g: 0, b: 0 },
      })).rejects.toThrow(/0-255/);
      await expect(cropTransparentBackground({
        sourceImgPath: SRC,
        padding: -1,
      })).rejects.toThrow(/padding/);
      await expect(cropTransparentBackground({
        sourceImgPath: SRC,
        targetTolerance: -10,
      })).rejects.toThrow(/tolerance/);
    });
  });

  it('生成的 PNG 可被再次读取且文件完整', () => {
    expect(isPng(readFileSync(CROP_OUTSIDE))).toBe(true);
    expect(isPng(readFileSync(CROP_INSIDE))).toBe(true);
  });
});