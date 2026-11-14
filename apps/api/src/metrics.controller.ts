import { Controller, Get, Headers, NotFoundException, Res, UnauthorizedException } from "@nestjs/common";
import type { Response } from "express";
import { registry } from "./metrics";
@Controller("metrics")
export class MetricsController {
  @Get() async read(@Headers("authorization") auth: string | undefined, @Res() response: Response) {
    const token = process.env.METRICS_BEARER_TOKEN;
    if (!token) throw new NotFoundException();
    if (auth !== `Bearer ${token}`) throw new UnauthorizedException();
    return response.type(registry.contentType).send(await registry.metrics());
  }
}
