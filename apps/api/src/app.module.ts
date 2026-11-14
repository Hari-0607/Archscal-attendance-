import { Module } from "@nestjs/common";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { AttendanceController } from "./attendance.controller";
import { AuthGuard } from "./auth.guard";
import { HealthController } from "./health.controller";
import { MetricsController } from "./metrics.controller";
import { MetricsInterceptor } from "./metrics.interceptor";
import { RedisThrottlerStorage } from "./redis-throttler.storage";
import { SupabaseService } from "./supabase.service";
import { SentryExceptionFilter } from "./sentry-exception.filter";
import { PrismaService } from "./prisma.service";
import { WorkforceController } from "./workforce.controller";

const throttlerStorage = process.env.REDIS_URL ? new RedisThrottlerStorage() : undefined;
@Module({ imports: [ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 120 }], ...(throttlerStorage ? { storage: throttlerStorage } : {}) })], controllers: [HealthController, MetricsController, AttendanceController, WorkforceController], providers: [PrismaService, SupabaseService, AuthGuard, ...(throttlerStorage ? [{ provide: RedisThrottlerStorage, useValue: throttlerStorage }] : []), { provide: APP_FILTER, useClass: SentryExceptionFilter }, { provide: APP_GUARD, useClass: ThrottlerGuard }, { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor }] })
export class AppModule {}
