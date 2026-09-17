import fs from 'node:fs/promises';
import sharp from 'sharp';
import { config } from './config.js';
import { AppError } from './errors.js';

export const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/heif': '.heif',
  'image/tiff': '.tif',
};

// 不信任客户端 Content-Type,按文件头魔数识别真实格式
export async function sniffMime(filePath) {
  const fh = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(16);
    const { bytesRead } = await fh.read(buf, 0, 16, 0);
    const b = buf.subarray(0, bytesRead);
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47) return 'image/png';
    if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return 'image/gif';
    if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
    if (b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp') {
      const brand = b.toString('latin1', 8, 12);
      if (brand === 'avif' || brand === 'avis') return 'image/avif';
      if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) return 'image/heif';
    }
    if (
      b.length >= 4 &&
      ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) ||
        (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a))
    ) {
      return 'image/tiff';
    }
    return null;
  } finally {
    await fh.close();
  }
}

// 上传校验:魔数 → sharp 解析元数据(完整性 + 像素上限)
export async function validateUpload(tmpPath) {
  const mime = await sniffMime(tmpPath);
  if (!mime) {
    throw new AppError(422, 'validation', '无法识别的图片格式,仅支持 JPEG/PNG/GIF/WebP/AVIF/HEIF/TIFF');
  }
  let meta;
  try {
    meta = await sharp(tmpPath, { limitInputPixels: config.maxPixels }).metadata();
  } catch (err) {
    if (/pixel limit/i.test(err.message)) {
      throw new AppError(413, 'validation', `图片像素超过上限 ${config.maxPixels}(疑似解压炸弹)`, err);
    }
    throw new AppError(422, 'corrupt_image', `图片已损坏或无法解析:${err.message}`, err);
  }
  if (!meta.width || !meta.height) {
    throw new AppError(422, 'corrupt_image', '图片缺少有效的尺寸信息');
  }
  return { mime, width: meta.width, height: meta.height };
}
