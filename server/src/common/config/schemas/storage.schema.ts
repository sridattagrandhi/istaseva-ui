import { z } from 'zod';

export const storageSchema = z.object({
  provider: z.enum(['s3', 'local']).default('s3'),
  awsRegion: z.string().min(1).default('ap-south-1'),
  awsAccessKeyId: z.string().optional(),
  awsSecretAccessKey: z.string().optional(),
  endpoint: z.string().url().optional(),
  forcePathStyle: z.preprocess((value) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
    }
    return value;
  }, z.boolean()).default(false),
  publicBaseUrl: z.string().url().optional(),
  bucketUploads: z.string().min(1),
  bucketVerification: z.string().min(1),
  bucketFrontend: z.string().min(1),
  bucketClaims: z.string().min(1),
  bucketChat: z.string().min(1),
  bucketListings: z.string().min(1),
  prefixListings: z.string().default('listings/'),
  prefixClaims: z.string().default('claims/'),
  prefixChat: z.string().default('chat/'),
  prefixVerification: z.string().default('verification/'),
  presignedUploadExpirySeconds: z.coerce.number().int().positive().max(3600).default(300),
  presignedDownloadExpirySeconds: z.coerce.number().int().positive().max(3600).default(300),
});
