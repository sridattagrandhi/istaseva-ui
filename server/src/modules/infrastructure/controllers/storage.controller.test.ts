// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppError } from '../../../common/errors/app-error.js';

const assertUploadPassesModeration = vi.fn();
const assertPresignedUploadAllowed = vi.fn();
const presignUpload = vi.fn();
const presignDownload = vi.fn();
const deleteObject = vi.fn();
const listObjects = vi.fn();
const writeFile = vi.fn();
const mkdir = vi.fn();

vi.mock('../services/image-moderation.service.js', () => ({
  assertUploadPassesModeration: (...args: unknown[]) => assertUploadPassesModeration(...args),
  assertPresignedUploadAllowed: (...args: unknown[]) => assertPresignedUploadAllowed(...args),
}));

vi.mock('../services/storage.service.js', () => ({
  storageService: { resolveBucketName: vi.fn((b: string) => b) },
}));

vi.mock('../../../common/providers/registry.js', () => ({
  getStorageProvider: vi.fn(async () => ({ presignUpload, presignDownload, deleteObject, listObjects })),
}));

vi.mock('../../../common/config/index.js', () => ({
  config: {
    app: { apiUrl: 'http://localhost:3001', port: 3001 },
    storage: { provider: 'local' },
  },
}));

vi.mock('node:fs', () => ({
  promises: { mkdir: (...args: unknown[]) => mkdir(...args), writeFile: (...args: unknown[]) => writeFile(...args) },
}));

const USER_ID = 'user-123';

function makeUploadReq(overrides: Record<string, unknown> = {}) {
  return {
    headers: {
      'x-upload-bucket': 'listing-images',
      'x-upload-key': `properties/${USER_ID}/photo.jpg`,
      'content-type': 'image/jpeg',
    },
    user: { id: USER_ID },
    body: Buffer.from('fake-image-bytes'),
    ...overrides,
  } as any;
}

describe('StorageController image moderation gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('proxyUpload rejects before persisting when moderation blocks the image', async () => {
    const rejection = new AppError(
      400,
      'This image appears to include explicit content. Please upload a different listing photo.',
      'IMAGE_CONTENT_REJECTED',
    );
    assertUploadPassesModeration.mockRejectedValue(rejection);

    const { storageController } = await import('./storage.controller.js');
    const res = { json: vi.fn() } as any;
    const next = vi.fn();

    await storageController.proxyUpload(makeUploadReq(), res, next);

    expect(next).toHaveBeenCalledWith(rejection);
    expect(res.json).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('proxyUpload persists and responds when moderation allows the image', async () => {
    assertUploadPassesModeration.mockResolvedValue(null);

    const { storageController } = await import('./storage.controller.js');
    const res = { json: vi.fn() } as any;
    const next = vi.fn();

    await storageController.proxyUpload(makeUploadReq(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(assertUploadPassesModeration).toHaveBeenCalledWith(expect.objectContaining({
      bucket: 'listing-images',
      key: `properties/${USER_ID}/photo.jpg`,
      contentType: 'image/jpeg',
    }));
    expect(writeFile).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('proxyUpload transcodes a real listing image to a smaller WebP and rewrites the key', async () => {
    assertUploadPassesModeration.mockResolvedValue(null);
    const { randomFillSync } = await import('node:crypto');
    const sharp = (await import('sharp')).default;
    const pixels = Buffer.allocUnsafe(1600 * 1200 * 3);
    randomFillSync(pixels);
    const jpeg = await sharp(pixels, { raw: { width: 1600, height: 1200, channels: 3 } })
      .jpeg({ quality: 92 })
      .toBuffer();

    const { storageController } = await import('./storage.controller.js');
    const res = { json: vi.fn() } as any;
    const next = vi.fn();

    await storageController.proxyUpload(makeUploadReq({ body: jpeg }), res, next);

    expect(next).not.toHaveBeenCalled();
    // The persisted file is a smaller WebP written under a rewritten .webp key.
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenBuf] = writeFile.mock.calls[0] as [string, Buffer];
    expect(String(writtenPath).endsWith('.webp')).toBe(true);
    expect(writtenBuf.length).toBeLessThan(jpeg.length);
    expect((await sharp(writtenBuf).metadata()).format).toBe('webp');
    // The response advertises the rewritten .webp key + url the client will store.
    const payload = res.json.mock.calls[0][0];
    expect(payload.key).toBe(`properties/${USER_ID}/photo.webp`);
    expect(String(payload.publicUrl).endsWith('.webp')).toBe(true);
  }, 20000);

  it('presignUpload refuses moderated buckets while moderation is enabled', async () => {
    const blocked = new AppError(
      400,
      'Listing image uploads must use /api/storage/upload while image moderation is enabled',
      'VALIDATION_ERROR',
    );
    assertPresignedUploadAllowed.mockImplementation(() => { throw blocked; });

    const { storageController } = await import('./storage.controller.js');
    const res = { json: vi.fn() } as any;
    const next = vi.fn();

    await storageController.presignUpload(
      {
        body: {
          bucket: 'listing-images',
          key: `properties/${USER_ID}/photo.jpg`,
          contentType: 'image/jpeg',
        },
        user: { id: USER_ID },
      } as any,
      res,
      next,
    );

    expect(next).toHaveBeenCalledWith(blocked);
    expect(presignUpload).not.toHaveBeenCalled();
  });
});

// SEC-002 regression: cross-tenant storage IDOR. An authenticated attacker
// supplying a victim-owned key must get a 403 and the storage provider must
// never be called.
describe('StorageController object-level authorization (SEC-002)', () => {
  const ATTACKER_ID = 'attacker-999';
  const VICTIM_KEY = `victim-456/passport.pdf`;

  function expect403(next: ReturnType<typeof vi.fn>) {
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(403);
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('presignDownload rejects a victim-owned key in a private bucket with 403', async () => {
    const { storageController } = await import('./storage.controller.js');
    const res = { json: vi.fn() } as any;
    const next = vi.fn();

    await storageController.presignDownload(
      { body: { bucket: 'verification-documents', key: VICTIM_KEY }, user: { id: ATTACKER_ID } } as any,
      res,
      next,
    );

    expect403(next);
    expect(presignDownload).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('presignDownload allows the owner of the key', async () => {
    presignDownload.mockResolvedValue({ url: 'https://signed' });
    const { storageController } = await import('./storage.controller.js');
    const res = { json: vi.fn() } as any;
    const next = vi.fn();

    await storageController.presignDownload(
      { body: { bucket: 'verification-documents', key: `${ATTACKER_ID}/own.pdf` }, user: { id: ATTACKER_ID } } as any,
      res,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(presignDownload).toHaveBeenCalled();
  });

  it('presignDownload leaves public-read buckets open to any authenticated user', async () => {
    presignDownload.mockResolvedValue({ url: 'https://signed' });
    const { storageController } = await import('./storage.controller.js');
    const res = { json: vi.fn() } as any;
    const next = vi.fn();

    await storageController.presignDownload(
      { body: { bucket: 'listing-images', key: `properties/${USER_ID}/photo.jpg` }, user: { id: ATTACKER_ID } } as any,
      res,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(presignDownload).toHaveBeenCalled();
  });

  it('delete rejects a victim-owned key with 403, even in a public-read bucket', async () => {
    const { storageController } = await import('./storage.controller.js');
    const res = { json: vi.fn() } as any;
    const next = vi.fn();

    await storageController.delete(
      { body: { bucket: 'listing-images', key: `properties/${USER_ID}/photo.jpg` }, user: { id: ATTACKER_ID } } as any,
      res,
      next,
    );

    expect403(next);
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it('delete allows the owner of the key', async () => {
    deleteObject.mockResolvedValue({ success: true });
    const { storageController } = await import('./storage.controller.js');
    const res = { json: vi.fn() } as any;
    const next = vi.fn();

    await storageController.delete(
      { body: { bucket: 'claims', key: `${ATTACKER_ID}/evidence.pdf` }, user: { id: ATTACKER_ID } } as any,
      res,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(deleteObject).toHaveBeenCalled();
  });

  it('list rejects a victim-scoped prefix on a private bucket with 403', async () => {
    const { storageController } = await import('./storage.controller.js');
    const res = { json: vi.fn() } as any;
    const next = vi.fn();

    await storageController.list(
      { query: { bucket: 'claim-evidence', prefix: 'victim-456/' }, user: { id: ATTACKER_ID } } as any,
      res,
      next,
    );

    expect403(next);
    expect(listObjects).not.toHaveBeenCalled();
  });

  it('list requires a prefix on private buckets', async () => {
    const { storageController } = await import('./storage.controller.js');
    const res = { json: vi.fn() } as any;
    const next = vi.fn();

    await storageController.list(
      { query: { bucket: 'verification-documents' }, user: { id: ATTACKER_ID } } as any,
      res,
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect((next.mock.calls[0][0] as AppError).statusCode).toBe(400);
    expect(listObjects).not.toHaveBeenCalled();
  });

  it('list allows a caller enumerating their own namespace', async () => {
    listObjects.mockResolvedValue({ objects: [] });
    const { storageController } = await import('./storage.controller.js');
    const res = { json: vi.fn() } as any;
    const next = vi.fn();

    await storageController.list(
      { query: { bucket: 'chat-attachments', prefix: `${ATTACKER_ID}/` }, user: { id: ATTACKER_ID } } as any,
      res,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(listObjects).toHaveBeenCalled();
  });
});
