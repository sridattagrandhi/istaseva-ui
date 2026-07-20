import { query } from '../../../common/db/postgres.js';
import type { ModerationResult } from '../services/image-moderation.service.js';

export interface ModerationLabelInput {
  bucket: string;
  storageKey: string;
  userId?: string | null;
  category?: string | null;
  result: ModerationResult;
}

/**
 * Record the model's verdict for one moderated image. Every gated upload gets
 * a row — allowed and rejected alike — building the labelled corpus for
 * future model training. Callers should treat this as fire-and-forget: a
 * label-write failure must never affect the upload itself.
 */
export async function insertModerationLabel(input: ModerationLabelInput): Promise<void> {
  const { result } = input;
  await query(
    `INSERT INTO image_moderation_labels
       (bucket, storage_key, user_id, verdict, reasons, nsfw_score, suggestive_score, detections, model, category)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      input.bucket,
      input.storageKey,
      input.userId ?? null,
      result.verdict,
      result.reasons,
      result.scores.nsfw ?? null,
      result.scores.suggestive ?? null,
      result.scores.nsfw_detections ? JSON.stringify(result.scores.nsfw_detections) : null,
      result.models?.nsfw ?? null,
      input.category ?? null,
    ],
  );
}
