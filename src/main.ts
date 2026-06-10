/**
 * image_lib  公共 API 入口
 *
 * 一个基于 @napi-rs/canvas 的图片处理库：
 * - 抠图：从源图提取边框，生成中间透明的"无字底图"
 * - 印章：动态生成自适应文本宽度的印章图片，支持远程/本地/系统字体
 *
 * @module
 */
export {
  //  印章生成 
  generateDynamicStamp,
  loadFont,
  downloadFont,
  resolveFontCachePath,
  //  编码工具 
  encodeCanvas,
  normalizeEncodeOptions,
  getMimeForFormat,
  getExtForFormat,
  //  常量 
  VALID_FONT_EXTS,
  DEFAULT_FONT_EXT,
  //  类型 
  type GenerateStampOptions,
  type FontCacheEntry,
  type EncodeFormat,
  type EncodeOptions,
  type TextRegion,
  type OverflowStrategy,
} from './create_dynamic_stamp';

export {
  //  抠图 
  cropTransparentBackground,
  type CropOptions,
  type CropResult,
  type KeepRegion,
  type Region,
  type RGB,
} from './create_image';