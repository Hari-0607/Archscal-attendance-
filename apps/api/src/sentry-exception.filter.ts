import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from "@nestjs/common";
import type { Request, Response } from "express";
import * as Sentry from "@sentry/node";

@Catch()
export class SentryExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const context = host.switchToHttp();
    const request = context.getRequest<Request & { requestId?: string }>();
    const response = context.getResponse<Response>();
    const prismaCode = exception && typeof exception === "object" && "code" in exception ? String((exception as { code: unknown }).code) : "";
    const prismaStatus: Record<string, number> = { P2002: 409, P2003: 400, P2025: 404 };
    const status = exception instanceof HttpException ? exception.getStatus() : prismaStatus[prismaCode] ?? 500;
    if (status >= 500) Sentry.withScope((scope) => { scope.setTag("request_id", request.headers["x-request-id"]?.toString() ?? "unknown"); Sentry.captureException(exception); });
    const body = exception instanceof HttpException ? exception.getResponse() : null;
    const message = status >= 500
      ? "Internal server error"
      : exception instanceof HttpException
        ? typeof body === "string" ? body : (body as { message?: string } | null)?.message ?? "Request failed"
        : prismaCode === "P2002" ? "A record with these details already exists"
          : prismaCode === "P2003" ? "A related record is invalid"
            : prismaCode === "P2025" ? "The requested record was not found" : "Request failed";
    const error = status >= 500 ? "Internal Server Error" : status === 409 ? "Conflict" : status === 404 ? "Not Found" : status === 400 ? "Bad Request" : "Request Failed";
    response.status(status).json({ statusCode: status, error, message, requestId: request.headers["x-request-id"] ?? null, timestamp: new Date().toISOString() });
  }
}
