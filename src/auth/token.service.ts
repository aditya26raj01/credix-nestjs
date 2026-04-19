import { Injectable, InternalServerErrorException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createCipheriv, createHash, createHmac, randomBytes } from 'crypto';

interface AccessTokenPayload {
  sub: string;
  email: string;
  role: string;
}

@Injectable()
export class TokenService {
  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
  ) {}

  async signAccessToken(payload: AccessTokenPayload) {
    return this.jwtService.signAsync(payload, {
      secret: this.getAccessTokenSecret(),
      expiresIn: this.getAccessTokenTtlSeconds(),
    });
  }

  async verifyAccessToken<T extends object>(token: string): Promise<T> {
    try {
      return await this.jwtService.verifyAsync<T>(token, {
        secret: this.getAccessTokenSecret(),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired access token.');
    }
  }

  getRefreshTokenTtlSeconds(): number {
    return this.getPositiveIntEnv('REFRESH_TOKEN_EXPIRES_IN_SECONDS', 2592000);
  }

  generateRefreshToken(): string {
    return randomBytes(48).toString('base64url');
  }

  hashRefreshToken(refreshToken: string): string {
    const refreshTokenPepper = this.getPreferredSecret(
      'REFRESH_TOKEN_PEPPER',
      'JWT_SECRET',
      'Missing REFRESH_TOKEN_PEPPER or JWT_SECRET.',
    );

    return createHmac('sha256', refreshTokenPepper).update(refreshToken).digest('hex');
  }

  encryptOpaqueToken(token: string): string {
    const rawKey = this.configService.get<string>('OAUTH_TOKEN_ENCRYPTION_KEY');

    if (!rawKey) {
      throw new InternalServerErrorException('Missing OAUTH_TOKEN_ENCRYPTION_KEY.');
    }

    const key = createHash('sha256').update(rawKey).digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return `${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
  }

  private getAccessTokenSecret(): string {
    return this.getPreferredSecret(
      'ACCESS_TOKEN_SECRET',
      'JWT_SECRET',
      'Missing ACCESS_TOKEN_SECRET or JWT_SECRET.',
    );
  }

  private getAccessTokenTtlSeconds(): number {
    return this.getPositiveIntEnv('ACCESS_TOKEN_EXPIRES_IN_SECONDS', 900);
  }

  private getPositiveIntEnv(key: string, fallback: number): number {
    const rawValue = this.configService.get<string>(key);
    const parsedValue = Number(rawValue ?? String(fallback));

    if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
      return fallback;
    }

    return parsedValue;
  }

  private getPreferredSecret(primaryKey: string, fallbackKey: string, message: string): string {
    const primarySecret = this.configService.get<string>(primaryKey);
    const fallbackSecret = this.configService.get<string>(fallbackKey);
    const secret = primarySecret || fallbackSecret;

    if (!secret) {
      throw new InternalServerErrorException(message);
    }

    return secret;
  }
}
