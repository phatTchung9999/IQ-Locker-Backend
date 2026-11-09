import { Avatar, AvatarSchema } from './model/avatar.schema.js';
import { AvatarService } from './service/avatar.service.js';
import { AvatarController } from './controller/avatar.controller.js';
import { Notification, NotificationSchema } from './model/notification.schema.js';
import { NotificationService } from './service/notification.service.js';
import { NotificationController } from './controller/notification.controller.js';
import "dotenv/config";
import { Module, RequestMethod, MiddlewareConsumer } from '@nestjs/common';
import { createObserveModule } from '@nestjs/observe';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { MongooseModule } from '@nestjs/mongoose';
import { ServeStaticModule } from '@nestjs/serve-static';
import { VideoController } from './controller/video.controller.js';
import { VideoService } from './service/video.service.js';
import { UserService } from './service/user.service.js';
import { UserController } from './controller/user.controller.js';
import { Video, VideoSchema } from './model/video.schema.js';
import { User, UserSchema } from './model/user.schema.js';
import { JwtModule } from '@nestjs/jwt';
import { getJwtSecret } from './utils/constants.js';
import { join } from 'node:path';
import { Server } from 'http';
import { MulterModule } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { CourseController } from './controller/course.controller.js';
import { CourseService } from './service/course.service.js';
import { Course, CourseSchema } from './model/course.schema.js';
import { FolderController } from './controller/folder.controller.js';
import { FolderService } from './service/folder.service.js';
import { Folder, FolderSchema } from './model/folder.schema.js';
import { Material, MaterialSchema, StorageUsage, StorageUsageSchema } from './model/material.schema.js';
import { ExtractionJob, ExtractionJobSchema } from './model/extraction-job.schema.js';
import { MaterialController } from './controller/material.controller.js';
import { MaterialService } from './service/material.service.js';
import { BlobStorageService } from './storage/blob-storage.service.js';
import { ExtractionWorkerService } from './extraction/extraction-worker.service.js';
import { ExtractedText, ExtractedTextSchema, ExtractedTextChunk, ExtractedTextChunkSchema } from './model/extracted-text.schema.js';
import { ExtractedTextService } from './extraction/extracted-text.service.js';
import { EXTRACTION_RESULT_WRITER } from './extraction/extraction.types.js';
import { ExtractionParserService } from './extraction/extraction-parser.service.js';
import { isAuthenticated } from './app.middleware.js';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    // Distributed tracing, auto-correlated logs, request/job metrics, error
    // telemetry, alarms, and more — out of the box. Sign up at https://observe.nestjs.com
    MongooseModule.forRoot(process.env.MONGO_URI ?? 'mongodb://localhost:27017/Stream',),
    MongooseModule.forFeature([{ name: Avatar.name, schema: AvatarSchema }, { name: Notification.name, schema: NotificationSchema }, { name: User.name, schema: UserSchema }]),
    MongooseModule.forFeature([{ name: Video.name, schema: VideoSchema }, { name: Course.name, schema: CourseSchema }, { name: Folder.name, schema: FolderSchema }, { name: Material.name, schema: MaterialSchema }, { name: StorageUsage.name, schema: StorageUsageSchema }, { name: ExtractionJob.name, schema: ExtractionJobSchema }, { name: ExtractedText.name, schema: ExtractedTextSchema }, { name: ExtractedTextChunk.name, schema: ExtractedTextChunkSchema }]),
    MulterModule.register({
      storage: diskStorage({
        destination: './public',
        filename: (req, file, cb) => {
          const ext = file.mimetype.split('/')[1];
          cb(null, `${uuidv4()}-${Date.now()}.${ext}`);
        },
      })
    }),
    ObserveModule.forRoot({
      appKey: 'YOUR_APP_KEY',
      appSecret: 'YOUR_APP_SECRET',
      serviceId: 'backend',
    }),
    JwtModule.register({
      secret: getJwtSecret(),
      signOptions: { expiresIn: '2h' },
    }),
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), 'public'),
    }),

  ],
  controllers: [AvatarController, NotificationController, AppController, VideoController, UserController, CourseController, FolderController, MaterialController],
  providers: [AvatarService, NotificationService, AppService, VideoService, UserService, CourseService, FolderService, MaterialService, BlobStorageService, ExtractionParserService, ExtractionWorkerService, ExtractedTextService, { provide: EXTRACTION_RESULT_WRITER, useExisting: ExtractedTextService }],
})
export class AppModule {
    configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(isAuthenticated)
      .exclude(
        { path: 'api/v1/video/:id', method: RequestMethod.GET }
      )
      .forRoutes(
        VideoController,
        CourseController,
        FolderController,
        MaterialController,
        NotificationController,
        AvatarController,
        { path: 'api/v1/user/me', method: RequestMethod.GET },
        { path: 'api/v1/user/me', method: RequestMethod.PATCH },
      );
  }
}
