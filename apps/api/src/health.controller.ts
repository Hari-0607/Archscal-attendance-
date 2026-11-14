import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
@Controller("health")
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}
  @Get() status() { return { status: "ok", service: "attendflow-api", timestamp: new Date().toISOString() }; }
  @Get("ready") async ready() {
    try { await this.prisma.$queryRaw`SELECT 1`; return { status: "ready" }; }
    catch { throw new ServiceUnavailableException({ status: "unavailable", dependency: "database" }); }
  }
}
