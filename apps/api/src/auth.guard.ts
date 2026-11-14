import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { createClient } from "@supabase/supabase-js";

@Injectable()
export class AuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const header = request.headers.authorization as string | undefined;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_ANON_KEY;
    if (!token || !url || !key) throw new UnauthorizedException("Authentication required");
    const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } });
    const { data, error } = await client.auth.getUser(token);
    if (error || !data.user) throw new UnauthorizedException("Invalid or expired session");
    request.user = { id: data.user.id, email: data.user.email ?? null };
    request.supabase = client;
    return true;
  }
}
