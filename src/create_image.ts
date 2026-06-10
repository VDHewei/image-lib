import { createCanvas, loadImage } from '@napi-rs/canvas';
import * as fs from 'fs';
import * as path from 'path';
import { encodeCanvas, type EncodeFormat, type EncodeOptions } from './create_dynamic_stamp';

/** RGB 颜色（0-255） */
export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** 矩形区域（绝对像素坐标，相对输出画布） */
export interface Region {
  /** 左上角 X */
  x: number;
  /** 左上角 Y */
  y: number;
  /** 宽度 */
  width: number;
  /** 高度 */
  height: number;
}

/**
 * 保留区域模式
 * - 'outside'（默认）: 保留目标颜色框 **之外** 的区域，框内整块抠成透明（输出尺寸 = 源图尺寸）
 * - 'inside'         : 保留目标颜色框 **之内** 的区域，裁剪到该矩形（输出尺寸 = 矩形尺寸）
 */
export type KeepRegion = 'outside' | 'inside';

/**
 * 抠图返回结构
 *
 * 含元数据，方便链式调用：
 *   const { buffer, region } = await cropTransparentBackground({ ... });
 *   await generateDynamicStamp({ backgroundPath, text, textRegion: region });
 */
export interface CropResult {
  /** 处理后的图片二进制数据（按 encodeOptions 指定的格式编码） */
  buffer: Buffer;
  /**
   * "抠除/保留"的核心矩形（绝对像素坐标，相对输出画布）。
   * - outside 模式：透明"洞"在画布中的位置（已包含 padding 收缩），可直接作为印章 textRegion 使用
   * - inside  模式：整张输出画布的尺寸 (x=0, y=0, width=输出宽, height=输出高)
   */
  region: Region;
  /** 输出画布宽度（像素） */
  width: number;
  /** 输出画布高度（像素） */
  height: number;
}

/**
 * 透明背景抠图选项
 *
 * 算法：颜色定位 + 区域抠除
 *
 * **inside 模式**（裁剪保留框内）：
 *   1. 定位 targetColor 像素的最小外接矩形
 *   2. 裁剪该矩形到新画布（可加 padding）
 *   3. 将画布中接近 transparentColor（默认白色）的像素 alpha 置 0
 *   4. 输出尺寸 = 矩形尺寸 + padding
 *
 * **outside 模式**（保留框外，默认）：
 *   1. 定位 targetColor 像素的最小外接矩形
 *   2. 以源图原尺寸为输出画布
 *   3. 将该矩形内部 **所有像素** alpha 置 0（含 padding 收缩）
 *   4. 默认 transparentColor=白色：框外白底像素同时透明化（"剩余白色默认透明"）
 *   5. 传 transparentColor: null 可关闭框外白底透明化
 */
export interface CropOptions {
  /** 源图片路径 */
  sourceImgPath: string;
  /** 输出文件路径（建议 .png 保留透明度） */
  outputPath?: string;
  /** 保留模式：默认 'outside'（保留框外） */
  keepRegion?: KeepRegion;
  /** 框选颜色（用于定位区域），默认黄色 rgb(255,215,0) */
  targetColor?: RGB;
  /** 框选颜色容差（欧氏距离），默认 80 */
  targetTolerance?: number;
  /**
   * 要额外转为透明的颜色（仅作用于"保留的"区域），**默认白色** rgb(255,255,255)。
   * - inside 模式：抠掉边框内的白底
   * - outside 模式：抠掉框外的白底，得到"只剩印章边框"的透明背景
   * 显式传 null 可强制不做颜色透明化（保留所有原色）。
   */
  transparentColor?: RGB | null;
  /** 透明色容差（欧氏距离），默认 40 */
  transparentTolerance?: number;
  /**
   * 矩形 padding（像素），默认 0
   * - inside 模式：向外扩展裁剪边界
   * - outside 模式：向内收缩透明区域（避免边框被一并抠掉）
   */
  padding?: number;
  /** 输出编码：默认 'png' */
  encodeOptions?: EncodeFormat | EncodeOptions;
}

/** 颜色欧氏距离 */
function colorDistance(r: number, g: number, b: number, c: RGB): number {
  const dr = r - c.r;
  const dg = g - c.g;
  const db = b - c.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function validateRGB(name: string, c: RGB): void {
  for (const k of ['r', 'g', 'b'] as const) {
    const v = c[k];
    if (!Number.isInteger(v) || v < 0 || v > 255) {
      throw new RangeError(`${name}.${k} 必须是 0-255 的整数，实际 ${v}`);
    }
  }
}

/**
 * 颜色定位抠图：以指定颜色（默认黄色）框选区域为基准，
 * 抠除框内或框外区域，剩余白色像素默认转为透明。
 *
 * @returns CropResult，含 buffer / region 元数据；若 outputPath 提供则同时写入磁盘
 * @throws 找不到目标颜色像素时抛错
 */
export async function cropTransparentBackground(options: CropOptions): Promise<CropResult> {
  const {
    sourceImgPath,
    outputPath,
    keepRegion = 'outside',
    targetColor = { r: 255, g: 215, b: 0 },
    targetTolerance = 80,
    transparentTolerance = 40,
    padding = 0,
    encodeOptions = 'png',
  } = options;

  // transparentColor 默认值：两种模式都默认抠白
  // - inside : 抠掉边框内的白底
  // - outside: 抠掉框外的白底，"剩余白色区域默认填充为透明"
  // 显式传 null 可关闭。
  const transparentColor: RGB | null = options.transparentColor !== undefined
    ? options.transparentColor
    : { r: 255, g: 255, b: 255 };

  //  参数校验 
  if (!sourceImgPath || typeof sourceImgPath !== 'string') {
    throw new TypeError('cropTransparentBackground: sourceImgPath 必须是非空字符串');
  }
  if (!fs.existsSync(sourceImgPath)) {
    throw new Error(`cropTransparentBackground: 源图不存在 "${sourceImgPath}"`);
  }
  if (keepRegion !== 'inside' && keepRegion !== 'outside') {
    throw new RangeError(`keepRegion 必须是 'inside' 或 'outside'，实际 "${keepRegion}"`);
  }
  validateRGB('targetColor', targetColor);
  if (transparentColor) validateRGB('transparentColor', transparentColor);
  if (targetTolerance < 0 || transparentTolerance < 0) {
    throw new RangeError('tolerance 不能为负数');
  }
  if (!Number.isInteger(padding) || padding < 0) {
    throw new RangeError(`padding 必须是非负整数，实际 ${padding}`);
  }

  // 1. 加载源图，读像素
  const srcImg = await loadImage(sourceImgPath);
  const srcW = srcImg.width;
  const srcH = srcImg.height;
  const srcCanvas = createCanvas(srcW, srcH);
  const srcCtx = srcCanvas.getContext('2d');
  srcCtx.drawImage(srcImg, 0, 0);
  const srcData = srcCtx.getImageData(0, 0, srcW, srcH).data;

  // 2. 扫描 targetColor 最小外接矩形
  let minX = srcW, minY = srcH, maxX = -1, maxY = -1, hitCount = 0;
  for (let y = 0; y < srcH; y++) {
    for (let x = 0; x < srcW; x++) {
      const i = (y * srcW + x) * 4;
      const r = srcData[i]!, g = srcData[i + 1]!, b = srcData[i + 2]!, a = srcData[i + 3]!;
      if (a < 128) continue;
      if (colorDistance(r, g, b, targetColor) <= targetTolerance) {
        hitCount++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (hitCount === 0) {
    throw new Error(
      `未在源图中找到目标颜色 rgb(${targetColor.r},${targetColor.g},${targetColor.b}) ` +
      `(容差 ${targetTolerance})。请检查 targetColor 或调大 targetTolerance。`,
    );
  }

  // 3. 分模式处理
  if (keepRegion === 'inside') {
    //  裁剪框内 + 抠白底 
    const cropX  = Math.max(0, minX - padding);
    const cropY  = Math.max(0, minY - padding);
    const cropX2 = Math.min(srcW - 1, maxX + padding);
    const cropY2 = Math.min(srcH - 1, maxY + padding);
    const cropW = cropX2 - cropX + 1;
    const cropH = cropY2 - cropY + 1;

    const outCanvas = createCanvas(cropW, cropH);
    const outCtx = outCanvas.getContext('2d');
    outCtx.drawImage(srcImg, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

    if (transparentColor) {
      const imgData = outCtx.getImageData(0, 0, cropW, cropH);
      const data = imgData.data;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
        if (colorDistance(r, g, b, transparentColor) <= transparentTolerance) {
          data[i + 3] = 0;
        }
      }
      outCtx.putImageData(imgData, 0, 0);
    }

    const buf = await encodeCanvas(outCanvas, encodeOptions);
    if (outputPath) {
      await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.promises.writeFile(outputPath, buf);
    }
    // inside 模式：region 即整张输出画布（从 0,0 起始）
    return {
      buffer: buf,
      region: { x: 0, y: 0, width: cropW, height: cropH },
      width: cropW,
      height: cropH,
    };
  }

  //  outside 模式：保留框外，框内置透明 
  // padding 在 outside 模式语义为"向内收缩"，避免误抠边框
  const holeX  = Math.max(0, minX + padding);
  const holeY  = Math.max(0, minY + padding);
  const holeX2 = Math.min(srcW - 1, maxX - padding);
  const holeY2 = Math.min(srcH - 1, maxY - padding);
  const validHole = holeX2 >= holeX && holeY2 >= holeY;

  // 复制源图到输出画布（保持原尺寸）
  const outCanvas = createCanvas(srcW, srcH);
  const outCtx = outCanvas.getContext('2d');
  outCtx.drawImage(srcImg, 0, 0);
  const imgData = outCtx.getImageData(0, 0, srcW, srcH);
  const data = imgData.data;

  for (let y = 0; y < srcH; y++) {
    for (let x = 0; x < srcW; x++) {
      const i = (y * srcW + x) * 4;
      const insideHole = validHole && x >= holeX && x <= holeX2 && y >= holeY && y <= holeY2;
      if (insideHole) {
        // 框内一律透明
        data[i + 3] = 0;
        continue;
      }
      if (transparentColor) {
        // 框外可选额外抠 transparentColor
        const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
        if (colorDistance(r, g, b, transparentColor) <= transparentTolerance) {
          data[i + 3] = 0;
        }
      }
    }
  }
  outCtx.putImageData(imgData, 0, 0);

  const buf = await encodeCanvas(outCanvas, encodeOptions);
  if (outputPath) {
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(outputPath, buf);
  }
  // outside 模式：region = 透明"洞"在画布中的位置（含 padding 收缩后的有效区）
  // 若 padding 过大导致 hole 无效，回退到原始 targetColor 外接矩形
  const regionX = validHole ? holeX : minX;
  const regionY = validHole ? holeY : minY;
  const regionW = validHole ? (holeX2 - holeX + 1) : (maxX - minX + 1);
  const regionH = validHole ? (holeY2 - holeY + 1) : (maxY - minY + 1);
  return {
    buffer: buf,
    region: { x: regionX, y: regionY, width: regionW, height: regionH },
    width: srcW,
    height: srcH,
  };
}