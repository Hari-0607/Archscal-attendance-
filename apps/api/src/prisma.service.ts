import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";

export type AuthenticatedPrincipal = {
  id: string;
  email: string;
  emailVerified: boolean;
};

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() { await this.$connect(); }
  async onModuleDestroy() { await this.$disconnect(); }

  async withAuthenticatedUser<T>(principal: AuthenticatedPrincipal, operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE authenticated");
      const claims = JSON.stringify({
        sub: principal.id,
        role: "authenticated",
        email: principal.email,
        email_verified: principal.emailVerified,
        aud: "authenticated",
      });
      await tx.$queryRaw`SELECT set_config('request.jwt.claim.sub', ${principal.id}, true), set_config('request.jwt.claims', ${claims}, true)`;
      return operation(tx);
    }, { maxWait: 5_000, timeout: 15_000 });
  }
}
