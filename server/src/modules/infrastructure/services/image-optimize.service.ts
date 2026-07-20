import sharp from 'sharp';
import { logger } from '../../../common/logging/logger.js';

// Buckets whose images we downscale + re-encode to WebP at upload time. This is
// deliberately the same set as the moderated listing-image buckets — user-facing
// marketplace photos. Verification/claims/chat/frontend uploads are left
// byte-exact (KYC and legal evidence must never be transcoded).
export const OPTIMIZED_BUCKETS = new Set([
  'listings',
  'listing-images',
  'listing-images-upload',
]);

// Raster formats we can safely transcode. PDFs aren't images here; GIF may be
// animated; SVG is vector — all are left untouched.
const OPTIMIZABLE_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// Cap the longest stored edge. 1600px still covers a retina hero on desktop
// while slashing a typical 3000px+ phone upload; cards render far smaller.
export const MAX_IMAGE_DIMENSION = 1600;
// WebP quality 80 is the widely-used size/clarity sweet spot.
export const WEBP_QUALITY = 80;

function normalizeContentType(contentType: string): string {
  return contentType.split(';')[0]?.trim().toLowerCase() || '';
}

/** True when this upload is a marketplace image we should transcode to WebP. */
export function isOptimizableUpload(bucket: string, contentType: string): boolean {
  return OPTIMIZED_BUCKETS.has(bucket)
    && OPTIMIZABLE_CONTENT_TYPES.has(normalizeContentType(contentType));
}

export interface OptimizedImage {
  body: Buffer;
  key: string;
  contentType: string;
  /** True only when we actually replaced the bytes with a smaller WebP. */
  optimized: boolean;
}

// Swap a recognized raster extension for .webp (or append it when there's none).
// Clients store the server-returned publicUrl/key rather than reconstructing
// their own, so rewriting the key is safe — and it keeps local-dev's
// extension-based MIME serving correct.
export function toWebpKey(key: string): string {
  return key.replace(/\.(jpe?g|png|webp)$/i, '') + '.webp';
}

/**
 * Downscale to MAX_IMAGE_DIMENSION (never upscaling) and re-encode as WebP.
 *
 * Best-effort by design: any failure — corrupt bytes, an unsupported/edge-case
 * image, or a result that isn't actually smaller — returns the ORIGINAL upload
 * untouched (same bytes, key, and content-type). An optimization must never cost
 * a user their upload. `rotate()` bakes in EXIF orientation so a re-encoded
 * portrait photo doesn't display sideways once the orientation tag is dropped.
 */
export async function optimizeListingImage(
  body: Buffer,
  key: string,
  contentType: string,
): Promise<OptimizedImage> {
  const original: OptimizedImage = { body, key, contentType, optimized: false };
  try {
    const out = await sharp(body)
      .rotate()
      .resize({ width: MAX_IMAGE_DIMENSION, height: MAX_IMAGE_DIMENSION, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();
    // Already-tiny images (e.g. small PNG icons) can grow when re-encoded — keep
    // the original in that case so we never make an upload larger.
    if (out.length >= body.length) return original;
    return { body: out, key: toWebpKey(key), contentType: 'image/webp', optimized: true };
  } catch (err) {
    logger.warn('image-optimize: transcode failed, storing original bytes', {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return original;
  }
}
