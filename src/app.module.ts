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
import { secret } from './utils/constants.js';
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
import { isAuthenticated } from './app.middleware.js';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    // Distributed tracing, auto-correlated logs, request/job metrics, error
    // telemetry, alarms, and more — out of the box. Sign up at https://observe.nestjs.com
    MongooseModule.forRoot(process.env.MONGO_URI ?? 'mongodb://localhost:27017/Stream',),
    MongooseModule.forFeature([{ name: User.name, schema: UserSchema }]),
    MongooseModule.forFeature([{ name: Video.name, schema: VideoSchema }, { name: Course.name, schema: CourseSchema }, { name: Folder.name, schema: FolderSchema }]),
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
      secret,
      signOptions: { expiresIn: '2h' },
    }),
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), 'public'),
    }),

  ],
  controllers: [AppController, VideoController, UserController, CourseController, FolderController],
  providers: [AppService, VideoService, UserService, CourseService, FolderService],
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
        { path: 'api/v1/user/me', method: RequestMethod.GET },
        { path: 'api/v1/user/me', method: RequestMethod.PATCH },
      );
  }
}
