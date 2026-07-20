import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3Client } from '../../../common/aws/clients.js';
import { config } from '../../../common/config/index.js';

export class StorageService {
  private bucketAliases: Record<string, string> = {
    uploads: config.storage.bucketUploads,
    listings: config.storage.bucketListings,
    'listing-images': config.storage.bucketListings,
    'listing-images-upload': config.storage.bucketListings,
    'verification-documents': config.storage.bucketVerification,
    verification: config.storage.bucketVerification,
    claims: config.storage.bucketClaims,
    'claim-evidence': config.storage.bucketClaims,
    chat: config.storage.bucketChat,
    'chat-attachments': config.storage.bucketChat,
    frontend: config.storage.bucketFrontend,
  };

  private bucketPrefixes: Record<string, string | undefined> = {
    listings: config.storage.prefixListings,
    'listing-images': config.storage.prefixListings,
    'listing-images-upload': config.storage.prefixListings,
    verification: config.storage.prefixVerification,
    'verification-documents': config.storage.prefixVerification,
    claims: config.storage.prefixClaims,
    'claim-evidence': config.storage.prefixClaims,
    chat: config.storage.prefixChat,
    'chat-attachments': config.storage.prefixChat,
  };

  resolveBucketName(bucket: string) {
    return this.bucketAliases[bucket] || bucket;
  }

  private normalizePrefix(prefix?: string) {
    if (!prefix) return '';
    return prefix.endsWith('/') ? prefix : `${prefix}/`;
  }

  private resolveKey(bucketAlias: string, key: string) {
    const normalizedPrefix = this.normalizePrefix(this.bucketPrefixes[bucketAlias]);
    if (!normalizedPrefix) return key;
    return key.startsWith(normalizedPrefix) ? key : `${normalizedPrefix}${key.replace(/^\/+/, '')}`;
  }

  private resolveListPrefix(bucketAlias: string, prefix?: string) {
    const basePrefix = this.normalizePrefix(this.bucketPrefixes[bucketAlias]);
    if (!prefix) return basePrefix || undefined;
    const normalizedProvided = prefix.replace(/^\/+/, '');
    if (!basePrefix) return normalizedProvided;
    return normalizedProvided.startsWith(basePrefix) ? normalizedProvided : `${basePrefix}${normalizedProvided}`;
  }

  buildPublicUrl(bucket: string, key: string) {
    const encodedKey = key.split('/').map(encodeURIComponent).join('/');
    if (config.storage.publicBaseUrl) {
      // CDN mode — URL is just <cdnBase>/<s3-key>, no bucket name in path.
      // The media CloudFront distribution routes to the correct bucket via
      // path-based behaviours (/<bucket-name>/* → that bucket's origin).
      const base = config.storage.publicBaseUrl.replace(/\/+$/, '');
      return `${base}/${encodedKey}`;
    }

    if (config.storage.endpoint) {
      const endpoint = config.storage.endpoint.replace(/\/+$/, '');
      return config.storage.forcePathStyle
        ? `${endpoint}/${bucket}/${encodedKey}`
        : `${endpoint.replace('://', `://${bucket}.`)}/${encodedKey}`;
    }

    return `https://${bucket}.s3.${config.aws.region}.amazonaws.com/${encodedKey}`;
  }

  /**
   * Rewrites a stored direct S3 URL to the media CDN URL.
   * Safe to call on any URL — returns it unchanged if it doesn't look like
   * an S3 object URL for one of our known buckets.
   *
   * Example:
   *   in:  https://instaserve-listings-staging.s3.ap-south-1.amazonaws.com/listings/foo.jpg
   *   out: https://d123.cloudfront.net/listings/foo.jpg
   */
  rewriteS3UrlToCdn(url: string | null | undefined): string | null | undefined {
    if (!url || !config.storage.publicBaseUrl) return url;
    const cdnBase = config.storage.publicBaseUrl.replace(/\/+$/, '');
    // Match virtual-hosted-style S3 URL: https://<bucket>.s3.<region>.amazonaws.com/<key>
    const match = url.match(/^https?:\/\/[^.]+\.s3\.[^.]+\.amazonaws\.com\/(.+)$/);
    if (match) return `${cdnBase}/${match[1]}`;
    return url;
  }

  rewriteS3UrlArrayToCdn(urls: (string | null | undefined)[] | null | undefined): string[] {
    if (!urls) return [];
    return urls.map((u) => this.rewriteS3UrlToCdn(u)).filter((u): u is string => Boolean(u));
  }

  async presignUpload(params: { bucket: string; key: string; contentType: string }) {
    const bucketName = this.resolveBucketName(params.bucket);
    const key = this.resolveKey(params.bucket, params.key);
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      ContentType: params.contentType,
    });

    return {
      uploadUrl: await getSignedUrl(s3Client, command, { expiresIn: config.storage.presignedUploadExpirySeconds }),
      publicUrl: this.buildPublicUrl(bucketName, key),
      bucket: bucketName,
      key,
    };
  }

  async presignDownload(params: { bucket: string; key: string }) {
    const bucketName = this.resolveBucketName(params.bucket);
    const key = this.resolveKey(params.bucket, params.key);
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: key,
    });

    return {
      downloadUrl: await getSignedUrl(s3Client, command, { expiresIn: config.storage.presignedDownloadExpirySeconds }),
      bucket: bucketName,
      key,
    };
  }

  /** Server-side direct write — used by the DSAR export job for its bundle. */
  async putObject(params: { bucket: string; key: string; body: string; contentType: string }) {
    const bucketName = this.resolveBucketName(params.bucket);
    const key = this.resolveKey(params.bucket, params.key);
    await s3Client.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: params.body,
      ContentType: params.contentType,
    }));
    return { bucket: bucketName, key };
  }

  async deleteObject(params: { bucket: string; key: string }) {
    const bucketName = this.resolveBucketName(params.bucket);
    const key = this.resolveKey(params.bucket, params.key);
    await s3Client.send(new DeleteObjectCommand({
      Bucket: bucketName,
      Key: key,
    }));
    return { success: true };
  }

  /**
   * Permanently delete every object VERSION and delete marker under a prefix
   * (PRIV-002). On production buckets `versioned: true` means DeleteObject
   * only writes a delete marker — the bytes stay retrievable by VersionId —
   * so the account-deletion sweep must purge versions explicitly. Works on
   * unversioned buckets too (versions listed with VersionId "null").
   */
  async purgeObjectVersions(params: { bucket: string; prefix: string }) {
    const bucketName = this.resolveBucketName(params.bucket);
    const prefix = this.resolveListPrefix(params.bucket, params.prefix);
    // Refuse a bucket-wide purge: an empty prefix here can only be a bug.
    if (!prefix || prefix === '/') {
      throw new Error('purgeObjectVersions requires a non-empty prefix');
    }

    let deleted = 0;
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    do {
      const page = await s3Client.send(new ListObjectVersionsCommand({
        Bucket: bucketName,
        Prefix: prefix,
        MaxKeys: 1000,
        ...(keyMarker ? { KeyMarker: keyMarker } : {}),
        ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {}),
      }));

      const targets = [...(page.Versions || []), ...(page.DeleteMarkers || [])]
        .filter((v): v is { Key: string; VersionId?: string } => Boolean(v.Key))
        .map((v) => ({ Key: v.Key, ...(v.VersionId ? { VersionId: v.VersionId } : {}) }));

      if (targets.length > 0) {
        await s3Client.send(new DeleteObjectsCommand({
          Bucket: bucketName,
          Delete: { Objects: targets, Quiet: true },
        }));
        deleted += targets.length;
      }

      keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
    } while (keyMarker || versionIdMarker);

    return { deleted };
  }

  async listObjects(params: { bucket: string; prefix?: string }) {
    const bucketName = this.resolveBucketName(params.bucket);
    const prefix = this.resolveListPrefix(params.bucket, params.prefix);

    // Paginate with the continuation token: the account-deletion sweep must
    // see EVERY object under a user's prefix, and a single page silently
    // capped the listing at MaxKeys (a user with >100 uploads kept orphans).
    const files: string[] = [];
    let continuationToken: string | undefined;
    do {
      const result = await s3Client.send(new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: prefix,
        MaxKeys: 1000,
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      }));
      files.push(...(result.Contents || []).map((item) => item.Key).filter((k): k is string => Boolean(k)));
      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken);

    return { files, bucket: bucketName };
  }
}

export const storageService = new StorageService();
