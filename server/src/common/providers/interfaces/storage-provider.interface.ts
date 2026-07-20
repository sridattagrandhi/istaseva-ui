/**
 * Future implementations:
 * - Amazon S3
 * - Cloudflare R2 / GCS
 * - Local filesystem for development
 */
export interface IStorageProvider {
  resolveBucketName(bucket: string): string;
  buildPublicUrl(bucket: string, key: string): string;
  presignUpload(params: { bucket: string; key: string; contentType: string }): Promise<{
    uploadUrl: string;
    publicUrl: string;
    bucket: string;
    key: string;
  }>;
  presignDownload(params: { bucket: string; key: string }): Promise<{
    downloadUrl: string;
    bucket: string;
    key: string;
  }>;
  deleteObject(params: { bucket: string; key: string }): Promise<{ success: boolean }>;
  listObjects(params: { bucket: string; prefix?: string }): Promise<{ files: string[]; bucket: string }>;
  /**
   * Permanently remove EVERY object version and delete marker under a prefix.
   * On versioned buckets a plain DeleteObject only writes a delete marker, so
   * account deletion must use this where available or "erased" bytes survive
   * as noncurrent versions (PRIV-002). Optional: providers without object
   * versioning (local disk) omit it and callers fall back to list+delete.
   */
  purgeObjectVersions?(params: { bucket: string; prefix: string }): Promise<{ deleted: number }>;
  /**
   * Server-side direct write (no presign round-trip). Used by the DSAR export
   * job to persist the generated bundle before handing back a download link.
   */
  putObject(params: { bucket: string; key: string; body: string; contentType: string }): Promise<{
    bucket: string;
    key: string;
  }>;
}
