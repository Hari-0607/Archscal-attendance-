import { Module } from "@nestjs/common";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { AuthGuard } from "./auth.guard";
import { SupabaseAuthService } from "./auth/supabase-auth.service";
import { HealthController } from "./health.controller";
import { MetricsController } from "./metrics.controller";
import { MetricsInterceptor } from "./metrics.interceptor";
import { RedisThrottlerStorage } from "./redis-throttler.storage";
import { SentryExceptionFilter } from "./sentry-exception.filter";
import { PrismaService } from "./prisma.service";
import { WorkforceController } from "./workforce.controller";
import { WorkforceService } from "./workforce/workforce.service";

const throttlerStorage = process.env.REDIS_URL ? new RedisThrottlerStorage() : undefined;
@Module({ imports: [ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 120 }], ...(throttlerStorage ? { storage: throttlerStorage } : {}) })], controllers: [HealthController, MetricsController, WorkforceController], providers: [PrismaService, SupabaseAuthService, WorkforceService, AuthGuard, ...(throttlerStorage ? [{ provide: RedisThrottlerStorage, useValue: throttlerStorage }] : []), { provide: APP_FILTER, useClass: SentryExceptionFilter }, { provide: APP_GUARD, useClass: ThrottlerGuard }, { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor }] })
export class AppModule {}
