import { S3Client } from '@aws-sdk/client-s3';
import { SESClient } from '@aws-sdk/client-ses';
import { SNSClient } from '@aws-sdk/client-sns';
import { config } from '../config/index.js';

const sharedAwsConfig = {
  region: config.aws.region,
  ...(config.storage.endpoint
    ? {
        endpoint: config.storage.endpoint,
        forcePathStyle: config.storage.forcePathStyle,
      }
    : {}),
  ...(config.aws.accessKeyId && config.aws.secretAccessKey
    ? {
        credentials: {
          accessKeyId: config.aws.accessKeyId,
          secretAccessKey: config.aws.secretAccessKey,
        },
      }
    : {}),
};

export const s3Client = new S3Client(sharedAwsConfig);
export const sesClient = new SESClient(sharedAwsConfig);
export const snsClient = new SNSClient(sharedAwsConfig);
