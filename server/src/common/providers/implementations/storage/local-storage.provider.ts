import fs from 'node:fs';
import path from 'node:path';
import type { IStorageProvider } from '../../interfaces/storage-provider.interface.js';
import { config } from '../../../config/index.js';

const UPLOAD_ROOT = path.resolve(process.cwd(), '.local-uploads');

/**
 * Local filesystem storage provider for development.
 * Files are saved to .local-uploads/<bucket>/<key> and served via /uploads/<bucket>/<key>.
 */
export class LocalStorageProvider implements IStorageProvider {
  private bucketAliases: Record<string, string> = {
    uploads: 'uploads',
    listings: 'listings',
    'listing-images': 'listings',
    'listing-images-upload': 'listings',
    'verification-documents': 'verification',
    verification: 'verification',
    claims: 'claims',
    'claim-evidence': 'claims',
    chat: 'chat',
    'chat-attachments': 'chat',
    frontend: 'frontend',
  };

  resolveBucketName(bucket: string): string {
    return this.bucketAliases[bucket] || bucket;
  }

  buildPublicUrl(bucket: string, key: string): string {
    const encodedKey = key.split('/').map(encodeURIComponent).join('/');
    const apiUrl = config.app.apiUrl || `http://localhost:${config.app.port}`;
    return `${apiUrl}/uploads/${bucket}/${encodedKey}`;
  }

  async presignUpload(params: { bucket: string; key: string; contentType: string }): Promise<{
    uploadUrl: string;
    publicUrl: string;
    bucket: string;
    key: string;
  }> {
    const bucketName = this.resolveBucketName(params.bucket);
    const apiUrl = config.app.apiUrl || `http://localhost:${config.app.port}`;
    const encodedKey = params.key.split('/').map(encodeURIComponent).join('/');

    // The "presigned" URL is just our local upload endpoint
    const uploadUrl = `${apiUrl}/api/storage/local-upload/${bucketName}/${encodedKey}`;
    const publicUrl = this.buildPublicUrl(bucketName, params.key);

    // Ensure directory exists
    const filePath = path.join(UPLOAD_ROOT, bucketName, params.key);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

    return { uploadUrl, publicUrl, bucket: bucketName, key: params.key };
  }

  async presignDownload(params: { bucket: string; key: string }): Promise<{
    downloadUrl: string;
    bucket: string;
    key: string;
  }> {
    const bucketName = this.resolveBucketName(params.bucket);
    const downloadUrl = this.buildPublicUrl(bucketName, params.key);
    return { downloadUrl, bucket: bucketName, key: params.key };
  }

  async deleteObject(params: { bucket: string; key: string }): Promise<{ success: boolean }> {
    const bucketName = this.resolveBucketName(params.bucket);
    const filePath = path.join(UPLOAD_ROOT, bucketName, params.key);
    try {
      await fs.promises.unlink(filePath);
    } catch {
      // File may not exist, that's fine
    }
    return { success: true };
  }

  async putObject(params: { bucket: string; key: string; body: string; contentType: string }): Promise<{
    bucket: string;
    key: string;
  }> {
    const bucketName = this.resolveBucketName(params.bucket);
    const filePath = path.join(UPLOAD_ROOT, bucketName, params.key);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, params.body, 'utf8');
    return { bucket: bucketName, key: params.key };
  }

  async listObjects(params: { bucket: string; prefix?: string }): Promise<{ files: string[]; bucket: string }> {
    const bucketName = this.resolveBucketName(params.bucket);
    const dir = path.join(UPLOAD_ROOT, bucketName, params.prefix || '');
    try {
      // Recursive, files-only — matches S3's prefix semantics. The one-level
      // readdir this replaced hid nested keys (e.g. <uid>/avatar/x.jpg) from
      // the account-deletion sweep in local dev.
      const entries = await fs.promises.readdir(dir, { recursive: true, withFileTypes: true });
      const files = entries
        .filter((entry) => entry.isFile())
        .map((entry) => {
          const rel = path.relative(dir, path.join(entry.parentPath ?? entry.path, entry.name));
          const relPosix = rel.split(path.sep).join('/');
          const prefix = (params.prefix || '').replace(/\/+$/, '');
          return prefix ? `${prefix}/${relPosix}` : relPosix;
        });
      return { files, bucket: bucketName };
    } catch {
      return { files: [], bucket: bucketName };
    }
  }
}

export const localStorageProvider = new LocalStorageProvider();
export const UPLOAD_ROOT_DIR = UPLOAD_ROOT;
