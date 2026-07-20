import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ForbiddenError, ValidationError } from '../../../common/errors/app-error.js';
import { getStorageProvider } from '../../../common/providers/registry.js';
import { storageService } from '../services/storage.service.js';
import {
  assertPresignedUploadAllowed,
  assertUploadPassesModeration,
} from '../services/image-moderation.service.js';
import { isOptimizableUpload, optimizeListingImage } from '../services/image-optimize.service.js';

const ALLOWED_UPLOAD_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// Buckets that serve publicly embeddable content (e.g. listing images loaded
// via <img src> on unauthenticated pages). Read access via /serve is open for
// these; writes are still scoped to the uploading user via assertKeyOwnedByUser.
export const PUBLIC_READ_BUCKETS = new Set([
  'listings',
  'listing-images',
  'listing-images-upload',
  'frontend',
]);

// Reject obviously malicious or ambiguous keys before they hit S3.
// Callers still need to run assertKeyOwnedByUser on top of this.
export function validateStorageKey(key: string): void {
  if (!key || key.length > 1024) throw new ValidationError('Invalid key length');
  if (key.startsWith('/')) throw new ValidationError('Key must not start with /');
  if (key.includes('..')) throw new ValidationError('Key must not contain ..');
  if (key.includes('//')) throw new ValidationError('Key must not contain empty path segments');
  if (key.includes('\\')) throw new ValidationError('Key must not contain backslashes');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(key)) throw new ValidationError('Key must not contain control characters');
}

// A user may only read/write keys scoped to themselves. We accept any key whose
// path contains the caller's id as a segment — this covers both the flat
// `${userId}/...` pattern and legacy `properties/${userId}/...` pattern already
// in use by the web/mobile clients, without breaking them.
export function assertKeyOwnedByUser(key: string, userId: string): void {
  const segments = key.split('/');
  if (!segments.includes(userId)) {
    throw new ValidationError('Key is not scoped to the authenticated user');
  }
}

// Same ownership rule, but surfaced as a 403 — used on read/delete/list paths
// where the caller supplied a syntactically valid key they simply don't own
// (SEC-002: cross-tenant storage IDOR).
function assertKeyOwnedByUserOr403(key: string, userId: string): void {
  try {
    assertKeyOwnedByUser(key, userId);
  } catch {
    throw new ForbiddenError('Not authorized to access this object');
  }
}

const presignUploadSchema = z.object({
  bucket: z.enum([
    'uploads',
    'listings',
    'listing-images',
    'listing-images-upload',
    'verification-documents',
    'verification',
    'claims',
    'claim-evidence',
    'chat',
    'chat-attachments',
    'frontend',
  ]),
  key: z.string().min(1),
  contentType: z.string().min(1),
  contentLength: z.number().positive().max(MAX_UPLOAD_BYTES).optional(),
});

const presignDownloadSchema = z.object({
  bucket: z.enum([
    'uploads',
    'listings',
    'listing-images',
    'listing-images-upload',
    'verification-documents',
    'verification',
    'claims',
    'claim-evidence',
    'chat',
    'chat-attachments',
    'frontend',
  ]),
  key: z.string().min(1),
});

export class StorageController {
  async presignUpload(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = presignUploadSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.message);
      if (!ALLOWED_UPLOAD_MIME_TYPES.has(parsed.data.contentType)) {
        throw new ValidationError('Unsupported file type. Allowed types: JPEG, PNG, WEBP, PDF');
      }
      if (parsed.data.contentLength && parsed.data.contentLength > MAX_UPLOAD_BYTES) {
        throw new ValidationError('File size exceeds the 10MB upload limit');
      }
      validateStorageKey(parsed.data.key);
      assertKeyOwnedByUser(parsed.data.key, req.user!.id);
      // Presigned puts go straight to S3, so the server never sees the bytes.
      // While moderation is enabled, listing images must go through /upload.
      assertPresignedUploadAllowed(parsed.data.bucket, parsed.data.contentType);
      const storageProvider = await getStorageProvider();
      res.json(await storageProvider.presignUpload({
        bucket: parsed.data.bucket,
        key: parsed.data.key,
        contentType: parsed.data.contentType,
      }));
    } catch (err) {
      next(err);
    }
  }

  async presignDownload(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = presignDownloadSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.message);
      validateStorageKey(parsed.data.key);
      // Mirror the /serve access model: public-read buckets are open to any
      // authenticated caller; private buckets require the key to be scoped
      // to the requesting user.
      if (!PUBLIC_READ_BUCKETS.has(parsed.data.bucket)) {
        assertKeyOwnedByUserOr403(parsed.data.key, req.user!.id);
      }
      const storageProvider = await getStorageProvider();
      res.json(await storageProvider.presignDownload(parsed.data));
    } catch (err) {
      next(err);
    }
  }

  async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = presignDownloadSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.message);
      validateStorageKey(parsed.data.key);
      // Deletes are writes: always owner-scoped, even in public-read buckets
      // (same rule as presignUpload/proxyUpload).
      assertKeyOwnedByUserOr403(parsed.data.key, req.user!.id);
      const storageProvider = await getStorageProvider();
      res.json(await storageProvider.deleteObject(parsed.data));
    } catch (err) {
      next(err);
    }
  }

  async proxyUpload(req: Request, res: Response, next: NextFunction) {
    try {
      const bucket = req.headers['x-upload-bucket'] as string;
      const key = req.headers['x-upload-key'] as string;
      const contentType = req.headers['content-type'] || 'application/octet-stream';

      if (!bucket || !key) {
        throw new ValidationError('Missing x-upload-bucket or x-upload-key headers');
      }

      const allowedBuckets = new Set([
        'uploads', 'listings', 'listing-images', 'listing-images-upload',
        'verification-documents', 'verification',
        'claims', 'claim-evidence', 'chat', 'chat-attachments', 'frontend',
      ]);
      if (!allowedBuckets.has(bucket)) {
        throw new ValidationError(`Invalid bucket: ${bucket}`);
      }

      if (!ALLOWED_UPLOAD_MIME_TYPES.has(contentType)) {
        throw new ValidationError('Unsupported file type. Allowed types: JPEG, PNG, WEBP, PDF');
      }

      validateStorageKey(key);
      // Assisted onboarding: an admin uploading listing photos FOR a host
      // declares the target via header, and the key must be scoped to the
      // TARGET's path (so the photos live where the host's own uploads
      // would). Explicit and role-gated — never inferred from the key.
      const uploadTargetUser = req.headers['x-upload-target-user'] as string | undefined;
      if (uploadTargetUser && req.user!.role === 'admin') {
        assertKeyOwnedByUser(key, uploadTargetUser);
      } else {
        assertKeyOwnedByUser(key, req.user!.id);
      }

      const body = req.body as Buffer;
      if (!body || body.length === 0) {
        throw new ValidationError('Empty file body');
      }
      if (body.length > MAX_UPLOAD_BYTES) {
        throw new ValidationError('File size exceeds the 10MB upload limit');
      }

      // NSFW gate for listing imagery. No-op unless IMAGE_MODERATION_URL is
      // set; throws IMAGE_CONTENT_REJECTED (400) before anything is persisted.
      // Runs on the ORIGINAL bytes (before any transcode) so the gate always
      // sees the exact format the user submitted.
      await assertUploadPassesModeration({
        bucket,
        key,
        bytes: body,
        contentType,
        category: (req.headers['x-listing-category'] as string | undefined) || null,
        userId: req.user!.id,
      });

      // Downscale + WebP-encode marketplace photos so we store/serve small files
      // instead of multi-MB phone originals (bandwidth + LCP win). Best-effort:
      // a transcode failure falls back to the original bytes/key/content-type.
      // Non-listing buckets and PDFs are left byte-exact by isOptimizableUpload.
      let uploadBody = body;
      let uploadKey = key;
      let uploadContentType = contentType;
      if (isOptimizableUpload(bucket, contentType)) {
        const optimized = await optimizeListingImage(body, key, contentType);
        uploadBody = optimized.body;
        uploadKey = optimized.key;
        uploadContentType = optimized.contentType;
      }

      const { config } = await import('../../../common/config/index.js');
      const apiBase = (config.app.apiUrl || `http://localhost:${config.app.port}`).replace(/\/+$/, '');
      const encodedKey = uploadKey.split('/').map(encodeURIComponent).join('/');
      const publicUrl = `${apiBase}/api/storage/serve/${encodeURIComponent(bucket)}/${encodedKey}`;

      // Local-disk mode: write to .local-uploads/{bucket}/{key} instead of S3.
      // Mirrors the convention used by /local-upload/:bucket/* in storage.routes.ts
      // so the same files are readable by /serve/:bucket/* in local mode.
      if (config.storage.provider === 'local') {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const UPLOAD_ROOT = path.resolve(process.cwd(), '.local-uploads');
        const filePath = path.resolve(UPLOAD_ROOT, bucket, uploadKey);
        // Defence-in-depth against path traversal (validateStorageKey already rejects "..").
        if (!filePath.startsWith(UPLOAD_ROOT + path.sep)) {
          throw new ValidationError('Invalid key');
        }
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.writeFile(filePath, uploadBody);
        res.json({ success: true, publicUrl, bucket, key: uploadKey });
        return;
      }

      // S3 mode (default): upload directly to the bucket.
      const { PutObjectCommand } = await import('@aws-sdk/client-s3');
      const { s3Client } = await import('../../../common/aws/clients.js');

      const bucketName = storageService.resolveBucketName(bucket);
      const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: uploadKey,
        Body: uploadBody,
        ContentType: uploadContentType,
      });
      await s3Client.send(command);

      res.json({ success: true, publicUrl, bucket: bucketName, key: uploadKey });
    } catch (err) {
      next(err);
    }
  }

  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = z.object({
        bucket: z.enum([
          'uploads',
          'listings',
          'listing-images',
          'listing-images-upload',
          'verification-documents',
          'verification',
          'claims',
          'claim-evidence',
          'chat',
          'chat-attachments',
          'frontend',
        ]),
        prefix: z.string().optional(),
      }).safeParse(req.query);

      if (!parsed.success) throw new ValidationError(parsed.error.message);
      // Private buckets: callers may only enumerate their own namespace, so a
      // prefix scoped to the requesting user is mandatory (SEC-002).
      if (!PUBLIC_READ_BUCKETS.has(parsed.data.bucket)) {
        if (!parsed.data.prefix) {
          throw new ValidationError('A prefix scoped to the authenticated user is required for this bucket');
        }
        validateStorageKey(parsed.data.prefix);
        assertKeyOwnedByUserOr403(parsed.data.prefix, req.user!.id);
      }
      const storageProvider = await getStorageProvider();
      res.json(await storageProvider.listObjects(parsed.data));
    } catch (err) {
      next(err);
    }
  }
}

export const storageController = new StorageController();
