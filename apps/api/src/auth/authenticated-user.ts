import type { Request } from "express";

export type AuthenticatedUser = {
  id: string;
  email: string;
  emailVerified: boolean;
};

export type AuthenticatedRequest = Request & { user: AuthenticatedUser };
