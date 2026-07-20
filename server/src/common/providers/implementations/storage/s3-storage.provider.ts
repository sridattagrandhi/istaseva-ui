import type { IStorageProvider } from '../../interfaces/storage-provider.interface.js';
import { storageService } from '../../../../modules/infrastructure/services/storage.service.js';

export class S3StorageProvider implements IStorageProvider {
  resolveBucketName(bucket: string) {
    return storageService.resolveBucketName(bucket);
  }

  buildPublicUrl(bucket: string, key: string) {
    return storageService.buildPublicUrl(bucket, key);
  }

  presignUpload(params: { bucket: string; key: string; contentType: string }) {
    return storageService.presignUpload(params);
  }

  presignDownload(params: { bucket: string; key: string }) {
    return storageService.presignDownload(params);
  }

  deleteObject(params: { bucket: string; key: string }) {
    return storageService.deleteObject(params);
  }

  putObject(params: { bucket: string; key: string; body: string; contentType: string }) {
    return storageService.putObject(params);
  }

  purgeObjectVersions(params: { bucket: string; prefix: string }) {
    return storageService.purgeObjectVersions(params);
  }

  listObjects(params: { bucket: string; prefix?: string }) {
    return storageService.listObjects(params).then((result) => ({
      ...result,
      files: result.files.filter((file): file is string => Boolean(file)),
    }));
  }
}

export const s3StorageProvider = new S3StorageProvider();
