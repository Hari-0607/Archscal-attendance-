import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { SupabaseAuthService } from "./auth/supabase-auth.service";

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: SupabaseAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const header = request.headers.authorization as string | undefined;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) throw new UnauthorizedException("Authentication required");
    request.user = await this.auth.verifyAccessToken(token);
    return true;
  }
}
