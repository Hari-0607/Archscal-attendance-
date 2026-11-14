import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Observable, tap } from "rxjs";
import { httpDuration, httpRequests } from "./metrics";
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const start = process.hrtime.bigint();
    return next.handle().pipe(tap({ finalize: () => {
      const route = request.route?.path ? `${request.baseUrl ?? ""}${request.route.path}` : "unmatched";
      if (route.endsWith("/metrics")) return;
      const labels = { method: request.method, route, status: String(response.statusCode) };
      httpRequests.inc(labels);
      httpDuration.observe(labels, Number(process.hrtime.bigint() - start) / 1e9);
    } }));
  }
}
