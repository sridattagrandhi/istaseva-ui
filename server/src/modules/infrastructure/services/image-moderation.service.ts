/**
 * Client for the local image-moderation microservice
 * (see `services/image-moderation/`).
 *
 * Wired into listing-image storage uploads as an opt-in gate. Set
 * IMAGE_MODERATION_URL to enable it for an environment.
 *
 * Safety / rollout behaviour:
 *   • If IMAGE_MODERATION_URL is unset, this is a no-op that returns `allow`,
 *     so wiring it in can ship dark and be enabled per-environment via env.
 *   • If the service is unreachable or errors, it FAILS OPEN (returns `allow`
 *     with `error` populated) so a moderation outage never blocks legitimate
 *     uploads. Flip `IMAGE_MODERATION_FAIL_CLOSED=true` to fail closed instead.
 */

import { AppError, ValidationError } from '../../../common/errors/app-error.js';
import { logger } from '../../../common/logging/logger.js';

export type ModerationVerdict = 'allow' | 'review' | 'block';

export interface ModerationResult {
  verdict: ModerationVerdict;
  reasons: string[];
  scores: {
    nsfw: number;
    suggestive?: number;
    category_prob: number | null;
    expected_category: string | null;
    top_category: string | null;
    per_category?: Record<string, number>;
    nsfw_detections?: Array<{ class?: string; score?: number; box?: number[] }>;
  };
  models?: { nsfw: string; clip: string };
  elapsed_ms?: number;
  error?: string;
}

const SERVICE_URL = process.env.IMAGE_MODERATION_URL?.replace(/\/+$/, '');
const FAIL_CLOSED = process.env.IMAGE_MODERATION_FAIL_CLOSED === 'true';
const TIMEOUT_MS = Number(process.env.IMAGE_MODERATION_TIMEOUT_MS ?? 8000);
const IMAGE_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * Buckets whose images should be moderated. Listing imagery only — verification
 * docs / chat attachments are out of scope here.
 */
export const MODERATED_BUCKETS = new Set([
  'listings',
  'listing-images',
  'listing-images-upload',
]);

export interface ModeratedUploadInput {
  bucket: string;
  key: string;
  bytes: Buffer | Uint8Array;
  contentType: string;
  category?: string | null;
  userId?: string | null;
}

function normalizeContentType(contentType: string): string {
  return contentType.split(';')[0]?.trim().toLowerCase() || 'application/octet-stream';
}

export function isImageModerationEnabled(): boolean {
  return Boolean(SERVICE_URL);
}

export function isModeratedImageUpload(bucket: string, contentType: string): boolean {
  return Boolean(SERVICE_URL)
    && MODERATED_BUCKETS.has(bucket)
    && IMAGE_CONTENT_TYPES.has(normalizeContentType(contentType));
}

function allow(reason: string, error?: string): ModerationResult {
  return {
    verdict: 'allow',
    reasons: [reason],
    scores: { nsfw: 0, category_prob: null, expected_category: null, top_category: null },
    ...(error ? { error } : {}),
  };
}

/**
 * Moderate one image. `category` is the claimed listing/service type (e.g. "cab",
 * "apartment") and may be omitted for an NSFW-only check.
 */
export async function moderateImage(
  bytes: Buffer | Uint8Array,
  contentType: string,
  category?: string | null,
): Promise<ModerationResult> {
  if (!SERVICE_URL) {
    // Moderation disabled for this environment.
    return allow('moderation_disabled');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const form = new FormData();
    const uploadBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const arrayBuffer = new ArrayBuffer(uploadBytes.byteLength);
    new Uint8Array(arrayBuffer).set(uploadBytes);
    const blob = new Blob([arrayBuffer], { type: normalizeContentType(contentType) });
    form.append('file', blob, 'upload');
    if (category) form.append('category', category);

    const res = await fetch(`${SERVICE_URL}/moderate`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return failOpenOrClosed(`moderation service ${res.status}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as ModerationResult;
  } catch (err: any) {
    return failOpenOrClosed(err?.message || 'moderation request failed');
  } finally {
    clearTimeout(timer);
  }
}

function failOpenOrClosed(error: string): ModerationResult {
  if (FAIL_CLOSED) {
    return { verdict: 'review', reasons: ['moderation_unavailable'],
      scores: { nsfw: 0, category_prob: null, expected_category: null, top_category: null }, error };
  }
  return allow('moderation_unavailable', error);
}

/** True if this verdict should prevent the upload from being persisted. */
export function shouldRejectUpload(result: ModerationResult): boolean {
  // There is no human-review queue in the upload path yet, so "review" cannot
  // safely become a public listing image.
  return result.verdict !== 'allow';
}

function rejectedMessage(result: ModerationResult): string {
  if (result.reasons.includes('moderation_unavailable')) {
    return 'Image moderation is temporarily unavailable. Please try again in a moment.';
  }
  if (result.reasons.includes('explicit_content') || result.reasons.includes('possible_explicit_content')) {
    return 'This image appears to include explicit content. Please upload a different listing photo.';
  }
  if (result.reasons.includes('suggestive_content')) {
    return 'This image looks too revealing for a listing photo. Please upload a different photo.';
  }
  return 'This image did not pass listing photo safety checks. Please upload a different photo.';
}

export async function assertUploadPassesModeration(input: ModeratedUploadInput): Promise<ModerationResult | null> {
  if (!isModeratedImageUpload(input.bucket, input.contentType)) {
    return null;
  }

  const result = await moderateImage(input.bytes, input.contentType, input.category);
  const logContext = {
    bucket: input.bucket,
    key: input.key,
    verdict: result.verdict,
    reasons: result.reasons,
    scores: result.scores,
    models: result.models,
    elapsedMs: result.elapsed_ms,
    error: result.error,
  };

  // Persist a training label for every REAL model verdict (skip fail-open
  // results — no model ran, so there is nothing to learn from). Fire-and-
  // forget: a label-write failure must never affect the upload.
  if (!result.error) {
    import('../repositories/image-moderation-labels.repository.js')
      .then((repo) => repo.insertModerationLabel({
        bucket: input.bucket,
        storageKey: input.key,
        userId: input.userId,
        category: input.category,
        result,
      }))
      .catch((err) => logger.warn('Failed to record image moderation label', {
        bucket: input.bucket, key: input.key, error: err?.message,
      }));
  }

  if (shouldRejectUpload(result)) {
    logger.warn('Rejected listing image upload during moderation', logContext);
    throw new AppError(400, rejectedMessage(result), 'IMAGE_CONTENT_REJECTED', {
      reasons: result.reasons,
      scores: {
        nsfw: result.scores.nsfw,
        category_prob: result.scores.category_prob,
        expected_category: result.scores.expected_category,
        top_category: result.scores.top_category,
      },
    });
  }

  logger.info('Listing image upload passed moderation', logContext);
  return result;
}

export function assertPresignedUploadAllowed(bucket: string, contentType: string): void {
  if (isModeratedImageUpload(bucket, contentType)) {
    throw new ValidationError('Listing image uploads must use /api/storage/upload while image moderation is enabled');
  }
}
