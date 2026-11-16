import { Controller, Get, Headers, NotFoundException, Res, UnauthorizedException } from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";
import type { Response } from "express";
import { registry } from "./metrics";
@Controller("metrics")
export class MetricsController {
  @Get() async read(@Headers("authorization") auth: string | undefined, @Res() response: Response) {
    const token = process.env.METRICS_BEARER_TOKEN;
    if (!token) throw new NotFoundException();
    const expected = Buffer.from(`Bearer ${token}`);
    const supplied = Buffer.from(auth ?? "");
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new UnauthorizedException();
    return response.type(registry.contentType).send(await registry.metrics());
  }
}
