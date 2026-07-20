import { describe, it, expect } from 'vitest';
import { randomFillSync } from 'node:crypto';
import sharp from 'sharp';
import {
  isOptimizableUpload,
  optimizeListingImage,
  toWebpKey,
  MAX_IMAGE_DIMENSION,
} from './image-optimize.service.js';

// A large, noisy JPEG so the source is a realistic multi-KB photo (a flat-colour
// image compresses to almost nothing and wouldn't exercise the size win). Noise
// is filled natively — a JS per-byte loop over ~13M bytes is far too slow.
async function makeLargeJpeg(width = 2400, height = 1800): Promise<Buffer> {
  const pixels = Buffer.allocUnsafe(width * height * 3);
  randomFillSync(pixels);
  return sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
}

describe('isOptimizableUpload', () => {
  it('accepts marketplace image buckets with raster content types', () => {
    expect(isOptimizableUpload('listings', 'image/jpeg')).toBe(true);
    expect(isOptimizableUpload('listing-images', 'image/png')).toBe(true);
    expect(isOptimizableUpload('listing-images-upload', 'image/webp')).toBe(true);
    expect(isOptimizableUpload('listings', 'image/jpeg; charset=binary')).toBe(true);
  });

  it('leaves non-listing buckets and non-raster types byte-exact', () => {
    expect(isOptimizableUpload('verification-documents', 'image/jpeg')).toBe(false);
    expect(isOptimizableUpload('claims', 'image/png')).toBe(false);
    expect(isOptimizableUpload('chat-attachments', 'image/jpeg')).toBe(false);
    expect(isOptimizableUpload('listings', 'application/pdf')).toBe(false);
  });
});

describe('toWebpKey', () => {
  it('rewrites a recognised raster extension to .webp', () => {
    expect(toWebpKey('u1/listing/photo.jpg')).toBe('u1/listing/photo.webp');
    expect(toWebpKey('u1/listing/photo.JPEG')).toBe('u1/listing/photo.webp');
    expect(toWebpKey('u1/listing/photo.png')).toBe('u1/listing/photo.webp');
    expect(toWebpKey('u1/listing/photo.webp')).toBe('u1/listing/photo.webp');
  });

  it('appends .webp when there is no recognised extension', () => {
    expect(toWebpKey('u1/listing/photo')).toBe('u1/listing/photo.webp');
  });

  it('only touches the trailing extension, not dots inside the path', () => {
    expect(toWebpKey('u1/my.photos/shot.jpg')).toBe('u1/my.photos/shot.webp');
  });
});

describe('optimizeListingImage', () => {
  it('transcodes to a smaller WebP and rewrites the key', async () => {
    const jpeg = await makeLargeJpeg();
    const result = await optimizeListingImage(jpeg, 'u1/listing/photo.jpg', 'image/jpeg');

    expect(result.optimized).toBe(true);
    expect(result.contentType).toBe('image/webp');
    expect(result.key).toBe('u1/listing/photo.webp');
    expect(result.body.length).toBeLessThan(jpeg.length);
    // Output really is WebP.
    const meta = await sharp(result.body).metadata();
    expect(meta.format).toBe('webp');
  }, 20000);

  it('downscales oversized images to the max dimension (never upscales)', async () => {
    const jpeg = await makeLargeJpeg(2400, 1800);
    const result = await optimizeListingImage(jpeg, 'u1/listing/big.jpg', 'image/jpeg');
    const meta = await sharp(result.body).metadata();
    expect(meta.width).toBeLessThanOrEqual(MAX_IMAGE_DIMENSION);
    expect(meta.height).toBeLessThanOrEqual(MAX_IMAGE_DIMENSION);
    // Aspect ratio preserved: a 2400x1800 (4:3) becomes 1600x1200.
    expect(meta.width).toBe(1600);
    expect(meta.height).toBe(1200);
  }, 20000);

  it('falls back to the original upload when the bytes are not a decodable image', async () => {
    const garbage = Buffer.from('this is definitely not an image', 'utf8');
    const result = await optimizeListingImage(garbage, 'u1/listing/broken.jpg', 'image/jpeg');

    expect(result.optimized).toBe(false);
    expect(result.body).toBe(garbage); // same bytes, untouched
    expect(result.key).toBe('u1/listing/broken.jpg'); // key unchanged on fallback
    expect(result.contentType).toBe('image/jpeg'); // content-type unchanged on fallback
  });
});
