import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from "@nestjs/common";
import type { Request, Response } from "express";
import * as Sentry from "@sentry/node";

@Catch()
export class SentryExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const context = host.switchToHttp();
    const request = context.getRequest<Request & { requestId?: string }>();
    const response = context.getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    if (status >= 500) Sentry.withScope((scope) => { scope.setTag("request_id", request.headers["x-request-id"]?.toString() ?? "unknown"); Sentry.captureException(exception); });
    const body = exception instanceof HttpException ? exception.getResponse() : null;
    const message = status >= 500 ? "Internal server error" : typeof body === "string" ? body : (body as { message?: string } | null)?.message ?? "Request failed";
    response.status(status).json({ statusCode: status, message, requestId: request.headers["x-request-id"] ?? null });
  }
}
