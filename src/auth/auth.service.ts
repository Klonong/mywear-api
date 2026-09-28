import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { AccessPayload } from '../common/auth';
import {
  hashPassword,
  randomToken,
  sha256,
  verifyPassword,
} from '../common/crypto';
import { MailService } from '../common/mail.service';
import { env, REFRESH_TOKEN_DAYS } from '../config';
import type { User } from '../generated/prisma/client';
import { PrismaService } from '../prisma.service';
import type { LoginDto, RegisterDto } from './dto';

const DAY = 24 * 60 * 60 * 1000;
export const publicUser = (u: User) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  phone: u.phone,
  birthday: u.birthday,
  preferredGender: u.preferredGender,
  role: u.role,
});

@Injectable()
export class AuthService {
  // Compared against when the email is unknown, so response time doesn't reveal which emails have accounts
  private dummyHash = hashPassword(randomToken());

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly mail: MailService,
  ) {}

  async register(dto: RegisterDto) {
    const email = dto.email.toLowerCase();
    if (await this.prisma.user.findUnique({ where: { email } }))
      throw new ConflictException(
        'An account with this email already exists. Sign in instead.',
      );
    const user = await this.prisma.user.create({
      data: {
        email,
        name: dto.name.trim(),
        passwordHash: await hashPassword(dto.password),
      },
    });
    return this.issue(user);
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });
    const ok = await verifyPassword(
      dto.password,
      user?.passwordHash ?? (await this.dummyHash),
    );
    if (!user || !ok)
      throw new UnauthorizedException('Email or password is incorrect.');
    return this.issue(user);
  }

  /** Rotates the refresh token: the old one stops working as soon as it is used. */
  async refresh(raw: string | undefined) {
    const session =
      raw &&
      (await this.prisma.session.findUnique({
        where: { tokenHash: sha256(raw) },
        include: { user: true },
      }));
    if (!session || session.expiresAt < new Date())
      throw new UnauthorizedException(
        'Your session has ended. Please sign in again.',
      );
    await this.prisma.session.delete({ where: { id: session.id } });
    return this.issue(session.user);
  }

  async logout(raw: string | undefined) {
    if (raw)
      await this.prisma.session.deleteMany({
        where: { tokenHash: sha256(raw) },
      });
  }

  /** Always succeeds, whether or not the email has an account. */
  async forgotPassword(email: string) {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });
    if (!user) return;
    const token = randomToken();
    await this.prisma.passwordReset.create({
      data: {
        userId: user.id,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    await this.mail.send(
      user.email,
      'Reset your MyWear password',
      `Reset your password within 1 hour: ${env.webOrigin}/reset-password?token=${token}`,
    );
  }

  async resetPassword(token: string, password: string) {
    const reset = await this.prisma.passwordReset.findUnique({
      where: { tokenHash: sha256(token) },
    });
    if (!reset || reset.usedAt || reset.expiresAt < new Date())
      throw new UnauthorizedException(
        'This reset link has expired. Request a new one.',
      );
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: reset.userId },
        data: { passwordHash: await hashPassword(password) },
      }),
      this.prisma.passwordReset.update({
        where: { id: reset.id },
        data: { usedAt: new Date() },
      }),
      // sign out everywhere
      this.prisma.session.deleteMany({ where: { userId: reset.userId } }),
    ]);
  }

  private async issue(user: User) {
    const payload: AccessPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };
    const refreshToken = randomToken();
    await this.prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: sha256(refreshToken),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_DAYS * DAY),
      },
    });
    // tidy up this user's expired sessions while we're here
    await this.prisma.session.deleteMany({
      where: { userId: user.id, expiresAt: { lt: new Date() } },
    });
    return {
      accessToken: await this.jwt.signAsync(payload),
      refreshToken,
      user: publicUser(user),
    };
  }
}
