import { Router, raw } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { requireAuth, optionalAuth } from '../../../common/auth/require-auth.js';
import {
  storageController,
  PUBLIC_READ_BUCKETS,
  assertKeyOwnedByUser,
  validateStorageKey,
} from '../controllers/storage.controller.js';
import { config } from '../../../common/config/index.js';
import { ForbiddenError, UnauthorizedError } from '../../../common/errors/app-error.js';

const router = Router();

router.post('/presign-upload', requireAuth, storageController.presignUpload.bind(storageController));
router.post('/presign-download', requireAuth, storageController.presignDownload.bind(storageController));
router.delete('/delete', requireAuth, storageController.delete.bind(storageController));
router.get('/list', requireAuth, storageController.list.bind(storageController));

// Serve files from S3 via presigned redirect.
//
// Access model:
//   • Public-read buckets (listing images, frontend assets) — served to anyone,
//     matching existing <img src> usage on unauthenticated pages. optionalAuth
//     still parses a token if present so future per-owner logic works.
//   • Private buckets (verification docs, claims, chat attachments, etc.) —
//     require auth AND the key must contain the caller's user id as a segment,
//     preventing key-guessing across users.
router.get('/serve/:bucket/*', optionalAuth, async (req, res, next) => {
  try {
    const bucket = String(req.params.bucket ?? '');
    const key = decodeURIComponent((req.params as any)[0]);
    if (!bucket || !key) { res.status(400).json({ error: 'Missing bucket or key' }); return; }
    validateStorageKey(key);

    if (!PUBLIC_READ_BUCKETS.has(bucket)) {
      if (!req.user?.id) throw new UnauthorizedError('Authentication required for this bucket');
      try {
        assertKeyOwnedByUser(key, req.user.id);
      } catch {
        // Convert the generic validation error to a 403 so the intent is clear.
        throw new ForbiddenError('Not authorized to read this object');
      }
    }

    // Local-disk mode: stream the file straight from .local-uploads/.
    // Staging/prod use STORAGE_PROVIDER=s3 and skip this branch entirely.
    if (config.storage.provider === 'local') {
      const UPLOAD_ROOT = path.resolve(process.cwd(), '.local-uploads');
      const filePath = path.resolve(UPLOAD_ROOT, bucket, key);
      if (!filePath.startsWith(UPLOAD_ROOT + path.sep)) {
        res.status(400).json({ error: 'Invalid key' });
        return;
      }
      if (!fs.existsSync(filePath)) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const mime =
        ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
        : ext === '.png' ? 'image/png'
        : ext === '.webp' ? 'image/webp'
        : ext === '.pdf' ? 'application/pdf'
        : 'application/octet-stream';
      res.setHeader('Content-Type', mime);
      res.setHeader(
        'Cache-Control',
        PUBLIC_READ_BUCKETS.has(bucket) ? 'public, max-age=3600' : 'private, max-age=3600',
      );
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const { s3Client } = await import('../../../common/aws/clients.js');
    const { storageService } = await import('../services/storage.service.js');

    const bucketName = storageService.resolveBucketName(bucket);
    const command = new GetObjectCommand({ Bucket: bucketName, Key: key });
    const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

    // Cache for 1 hour since presigned URL is valid for 1 hour.
    // For private buckets mark as private so shared caches don't store it.
    res.setHeader(
      'Cache-Control',
      PUBLIC_READ_BUCKETS.has(bucket) ? 'public, max-age=3600' : 'private, max-age=3600',
    );
    res.redirect(signedUrl);
  } catch (err) {
    next(err);
  }
});

// Server-side proxy upload — bypasses S3 CORS issues by uploading through the server
router.post(
  '/upload',
  requireAuth,
  raw({ type: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], limit: '10mb' }),
  storageController.proxyUpload.bind(storageController)
);

// Local file upload endpoint (only active when STORAGE_PROVIDER=local)
if (config.storage.provider === 'local') {
  const UPLOAD_ROOT = path.resolve(process.cwd(), '.local-uploads');

  router.put(
    '/local-upload/:bucket/*',
    requireAuth,
    raw({ type: '*/*', limit: '10mb' }),
    async (req, res) => {
      try {
        const bucket = String(req.params.bucket ?? '');
        // Express puts the wildcard match in params[0]
        const key = decodeURIComponent((req.params as any)[0]);
        validateStorageKey(key);
        assertKeyOwnedByUser(key, req.user!.id);

        // Guard against path traversal escaping UPLOAD_ROOT even though
        // validateStorageKey already rejects ".." — defence in depth.
        const filePath = path.resolve(UPLOAD_ROOT, bucket, key);
        if (!filePath.startsWith(UPLOAD_ROOT + path.sep)) {
          res.status(400).json({ error: 'Invalid key' });
          return;
        }

        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.writeFile(filePath, req.body);

        res.json({ success: true, bucket, key });
      } catch (err: any) {
        const status = err?.statusCode ?? 500;
        res.status(status).json({ error: err.message || 'Upload failed' });
      }
    }
  );
}

export default router;
