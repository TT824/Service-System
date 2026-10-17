import 'reflect-metadata';
import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import type { AppConfig } from '@kefu/core';
import { AccountModule } from './account/account.module';
import { AdminModule } from './admin/admin.module';
import { AssignmentModule } from './assignment/assignment.module';
import { AuthModule } from './auth/auth.module';
import { ChannelsModule } from './channels/channels.module';
import { AppConfigModule } from './config/app-config.module';
import { RequestContextModule } from './context/request-context.module';
import { ConversationsModule } from './conversations/conversations.module';
import { DatabaseModule } from './database/database.module';
import { ExportsModule } from './exports/exports.module';
import { HealthModule } from './health/health.module';
import { AllExceptionsFilter } from './http/all-exceptions.filter';
import { ResponseEnvelopeInterceptor } from './http/response-envelope.interceptor';
import { IdentityModule } from './identity/identity.module';
import { InternalChatModule } from './internal-chat/internal-chat.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { LoggingModule } from './logging/logging.module';
import { MediaModule } from './media/media.module';
import { PersonalPhrasesModule } from './personal-phrases/personal-phrases.module';
import { PlatformModule } from './platform/platform.module';
import { RealtimeModule } from './realtime/realtime.module';
import { ReportsModule } from './reports/reports.module';
import { RetrievalModule } from './retrieval/retrieval.module';
import { ReviewModule } from './review/review.module';

/**
 * Root application module for the HTTP API.
 *
 * The module is created through {@link AppModule.register} with an
 * already-parsed {@link AppConfig} so configuration is parsed exactly once in
 * the composition root (`main.ts`) and every provider receives the same value.
 */
@Module({})
export class AppModule {
  /**
   * Register the API with a parsed configuration value.
   *
   * @param config - Parsed application configuration.
   * @returns The configured root module.
   */
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        AppConfigModule.register(config),
        LoggingModule,
        RequestContextModule,
        PlatformModule,
        // Registered before the feature modules so the global identity guard is
        // in place for every route they declare.
        AuthModule,
        AccountModule,
        AdminModule,
        IdentityModule,
        InternalChatModule,
        ConversationsModule,
        AssignmentModule,
        ExportsModule,
        KnowledgeModule,
        PersonalPhrasesModule,
        RetrievalModule,
        ReviewModule,
        ReportsModule,
        ChannelsModule,
        DatabaseModule,
        HealthModule,
        MediaModule,
        RealtimeModule,
      ],
      providers: [
        // Global exception filter keeps every error in the stable
        // `{ request_id, code, message, details }` shape.
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        // Global success envelope `{ request_id, data, meta }`.
        { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
      ],
    };
  }
}
