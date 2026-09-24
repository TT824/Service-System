import { Module, type Provider } from '@nestjs/common';
import type { AppConfig } from '@kefu/core';
import { APP_CONFIG } from '../config/app-config.module';
import { MediaController } from './media.controller';
import { MEDIA_STORAGE } from './media-storage';
import { MediaUrlService } from './media-url.service';
import { MessageMediaService } from './media.service';
import { MinioMediaStorage, minioObjectClient } from './minio-media-storage';

/**
 * The object storage binding.
 *
 * Built from the same `OBJECT_STORAGE_*` variables the readiness probe checks,
 * so "the store is reachable" means the same thing to the health endpoint and to
 * a customer's picture. Nothing here connects at boot: the client is lazy, and
 * an object store that is not up yet is a message stored without its bytes
 * rather than a process that refuses to start.
 */
const mediaStorageProvider: Provider = {
  provide: MEDIA_STORAGE,
  useFactory: (config: AppConfig) =>
    new MinioMediaStorage(
      minioObjectClient({
        endPoint: config.objectStorage.endpoint,
        port: config.objectStorage.port,
        useSSL: config.objectStorage.useSsl,
        accessKey: config.objectStorage.accessKey.unwrap(),
        secretKey: config.objectStorage.secretKey.unwrap(),
        bucket: config.objectStorage.bucket,
      }),
      config.objectStorage.bucket,
    ),
  inject: [APP_CONFIG],
};

/**
 * Customer media: keeping it at ingest, serving it under a signed URL.
 *
 * Both halves are exported because they are used in different places — the
 * channels module calls {@link MessageMediaService.capture} from the ingest path,
 * while the transcripts that show a picture mint their URL through
 * {@link MediaUrlService}.
 */
@Module({
  controllers: [MediaController],
  providers: [mediaStorageProvider, MediaUrlService, MessageMediaService],
  exports: [MessageMediaService, MediaUrlService],
})
export class MediaModule {}
