import {
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createCipheriv, createHash, createHmac, randomBytes } from 'crypto';
import { AppConfigService } from '../config/app-config.service';

interface AccessTokenPayload {
  sub: string;
  email: string;
  role: string;
}

@Injectable()
export class TokenService {
  constructor(
    private readonly appConfigService: AppConfigService,
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
    return this.appConfigService.getPositiveInt(
      'REFRESH_TOKEN_EXPIRES_IN_SECONDS',
      2592000,
    );
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

    return createHmac('sha256', refreshTokenPepper)
      .update(refreshToken)
      .digest('hex');
  }

  encryptOpaqueToken(token: string): string {
    const rawKey = this.appConfigService.getRequiredString(
      'OAUTH_TOKEN_ENCRYPTION_KEY',
    );

    const key = createHash('sha256').update(rawKey).digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([
      cipher.update(token, 'utf8'),
      cipher.final(),
    ]);
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
    return this.appConfigService.getPositiveInt(
      'ACCESS_TOKEN_EXPIRES_IN_SECONDS',
      900,
    );
  }

  private getPreferredSecret(
    primaryKey: string,
    fallbackKey: string,
    message: string,
  ): string {
    const primarySecret = this.appConfigService.getString(primaryKey);
    const fallbackSecret = this.appConfigService.getString(fallbackKey);
    const secret = primarySecret || fallbackSecret;

    if (!secret) {
      throw new InternalServerErrorException(message);
    }

    return secret;
  }
}
