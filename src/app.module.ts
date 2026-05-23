import { ClassSerializerInterceptor, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { ClsModule } from 'nestjs-cls';
import { dataSourceOptions } from './database/data-source';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { AttachmentsModule } from './modules/attachments/attachments.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { CommentsModule } from './modules/comments/comments.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { SchedulerModule } from './modules/scheduler/scheduler.module';
import { TicketsModule } from './modules/tickets/tickets.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // CLS module mounted as middleware. The user/actor is populated INSIDE
    // JwtStrategy.validate() (Phase 1, D6), NOT here — middleware runs before
    // guards, so req.user would be undefined at this point.
    ClsModule.forRoot({
      global: true,
      middleware: { mount: true },
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService): TypeOrmModuleOptions => ({
        ...dataSourceOptions,
        host: config.get<string>('DB_HOST', dataSourceOptions.host as string),
        port: config.get<number>('DB_PORT', dataSourceOptions.port as number),
        username: config.get<string>(
          'DB_USERNAME',
          dataSourceOptions.username as string,
        ),
        password: config.get<string>(
          'DB_PASSWORD',
          dataSourceOptions.password as string,
        ),
        database: config.get<string>(
          'DB_DATABASE',
          dataSourceOptions.database as string,
        ),
      }),
    }),
    UsersModule,
    AuthModule,
    ProjectsModule,
    TicketsModule,
    CommentsModule,
    AuditModule,
    AttachmentsModule,
    SchedulerModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    // JwtAuthGuard runs first, then RolesGuard checks @Roles metadata.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    // ClassSerializerInterceptor runs @Exclude() decorators (e.g. on User.passwordHash).
    { provide: APP_INTERCEPTOR, useClass: ClassSerializerInterceptor },
  ],
})
export class AppModule {}
