import { Controller, Get, Optional, ServiceUnavailableException } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import { RedisThrottlerStorage } from "./redis-throttler.storage";
@Controller("health")
export class HealthController {
  constructor(private readonly prisma: PrismaService, @Optional() private readonly redis?: RedisThrottlerStorage) {}
  @Get() status() { return { status: "ok", service: "attendflow-api", timestamp: new Date().toISOString() }; }
  @Get("ready") async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      if (process.env.NODE_ENV === "production" && (!this.redis || !(await this.redis.healthCheck()))) throw new Error("Redis unavailable");
      return { status: "ready" };
    } catch { throw new ServiceUnavailableException({ status: "unavailable", dependency: "required-service" }); }
  }
}
