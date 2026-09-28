import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import type { Role } from '../generated/prisma/enums';

export type AuthUser = { id: string; email: string; role: Role };
export type AccessPayload = { sub: string; email: string; role: Role };
export type AppRequest = Request & { user?: AuthUser };

const AUTH_KEY = 'auth:roles';

/**
 * Marks a route as requiring a signed-in user. With roles, only those roles (and admin) may call it.
 * Routes without @Auth are public; a valid token still populates the user (e.g. cart merges for members).
 */
export const Auth = (...roles: Role[]) => SetMetadata(AUTH_KEY, roles);

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) =>
    ctx.switchToHttp().getRequest<AppRequest>().user,
);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
  ) {}

  canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      try {
        const p = this.jwt.verify<AccessPayload>(header.slice(7));
        req.user = { id: p.sub, email: p.email, role: p.role };
      } catch {
        // expired or forged: treat as anonymous, protected routes answer 401 below so the client refreshes
      }
    }

    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(
      AUTH_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!roles) return true;
    if (!req.user) throw new UnauthorizedException('Sign in to continue');
    if (
      roles.length &&
      req.user.role !== 'admin' &&
      !roles.includes(req.user.role)
    )
      throw new ForbiddenException();
    return true;
  }
}
