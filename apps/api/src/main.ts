import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import helmet from "helmet";
import * as Sentry from "@sentry/node";
import { randomUUID } from "node:crypto";
import { AppModule } from "./app.module";

async function bootstrap() {
  if (process.env.NODE_ENV === "production" && !process.env.REDIS_URL) throw new Error("REDIS_URL is required for distributed API rate limiting in production");
  if (process.env.SENTRY_DSN) Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV ?? "development", tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.05), sendDefaultPii: false });
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.use(helmet());
  app.use((req, res, next) => {
    const requestId = randomUUID();
    res.setHeader("X-Request-Id", requestId);
    const started = process.hrtime.bigint();
    res.on("finish", () => console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: res.statusCode >= 500 ? "error" : "info", requestId, method: req.method, route: req.route?.path ?? req.path, status: res.statusCode, durationMs: Number(process.hrtime.bigint() - started) / 1e6 })));
    next();
  });
  app.enableCors({ origin: (process.env.CORS_ORIGINS ?? "http://localhost:3000").split(",").map((x) => x.trim()), credentials: true, methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"] });
  app.setGlobalPrefix("api/v1");
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 4000), "0.0.0.0");
}
void bootstrap();
