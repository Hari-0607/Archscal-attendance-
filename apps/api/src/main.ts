import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import helmet from "helmet";
import * as Sentry from "@sentry/node";
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { AppModule } from "./app.module";

async function bootstrap() {
  const production = process.env.NODE_ENV === "production";
  if (production) {
    const required = ["DATABASE_URL", "SUPABASE_URL", "SUPABASE_ANON_KEY", "REDIS_URL", "CORS_ORIGINS", "IP_HASH_SECRET"];
    const missing = required.filter((key) => !process.env[key]?.trim());
    if (missing.length) throw new Error(`Missing required production configuration: ${missing.join(", ")}`);
    if (Buffer.byteLength(process.env.IP_HASH_SECRET!, "utf8") < 32) throw new Error("IP_HASH_SECRET must contain at least 32 bytes");
    for (const value of process.env.CORS_ORIGINS!.split(",").map((origin) => origin.trim())) {
      let parsed: URL;
      try { parsed = new URL(value); } catch { throw new Error("CORS_ORIGINS must contain valid origin URLs"); }
      if (parsed.origin !== value || (parsed.protocol !== "https:" && parsed.hostname !== "localhost")) throw new Error("Production CORS origins must be HTTPS origins");
    }
  }
  if (process.env.SENTRY_DSN) Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV ?? "development",
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.05),
    beforeSend(event) {
      if (event.request) { delete event.request.data; delete event.request.cookies; delete event.request.headers; delete event.request.url; delete event.request.query_string; }
      for (const item of event.exception?.values ?? []) item.value = item.type ? `${item.type} (message redacted)` : "Server error (message redacted)";
      delete event.user;
      return event;
    },
    beforeSendTransaction(event) {
      if (event.request) { delete event.request.data; delete event.request.cookies; delete event.request.headers; delete event.request.url; delete event.request.query_string; }
      delete event.user;
      return event;
    },
  });
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const proxyHops = Number(process.env.TRUST_PROXY_HOPS ?? (production ? "1" : "0"));
  if (!Number.isSafeInteger(proxyHops) || proxyHops < 0 || proxyHops > 5 || (production && proxyHops === 0)) throw new Error("TRUST_PROXY_HOPS must be an integer from 1 to 5 in production and 0 to 5 otherwise");
  app.getHttpAdapter().getInstance().set("trust proxy", proxyHops);
  app.use(helmet());
  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = randomUUID();
    res.setHeader("X-Request-Id", requestId);
    const started = process.hrtime.bigint();
    res.on("finish", () => console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: res.statusCode >= 500 ? "error" : "info", requestId, method: req.method, route: req.route?.path ?? req.path, status: res.statusCode, durationMs: Number(process.hrtime.bigint() - started) / 1e6 })));
    next();
  });
  app.enableCors({ origin: (process.env.CORS_ORIGINS ?? "http://localhost:3000").split(",").map((x) => x.trim()), credentials: false, methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"], allowedHeaders: ["Authorization", "Content-Type", "Idempotency-Key"] });
  app.setGlobalPrefix("api/v1");
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 4000), "0.0.0.0");
}
void bootstrap();
