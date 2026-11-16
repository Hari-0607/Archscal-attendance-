import { Injectable, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AuthenticatedUser } from "./authenticated-user";

@Injectable()
export class SupabaseAuthService {
  private readonly client: SupabaseClient;

  constructor() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_ANON_KEY;
    if (!url || !key) throw new ServiceUnavailableException("Authentication provider is not configured");
    this.client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  }

  async verifyAccessToken(token: string): Promise<AuthenticatedUser> {
    const { data, error } = await this.client.auth.getUser(token);
    if (error || !data.user) throw new UnauthorizedException("Invalid or expired access token");
    return {
      id: data.user.id,
      email: data.user.email?.trim().toLowerCase() ?? "",
      emailVerified: Boolean(data.user.email_confirmed_at),
    };
  }
}
