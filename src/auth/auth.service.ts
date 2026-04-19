import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { OAuth2Client, TokenPayload } from 'google-auth-library';
import { createHmac, randomBytes } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { RefreshTokenEntity } from './refresh-token.entity';
import { UserEntity, UserRole } from '../user/user.entity';

interface RequestMeta {
  userAgent?: string;
  ipAddress?: string;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly usersRepository: Repository<UserEntity>,
    @InjectRepository(RefreshTokenEntity)
    private readonly refreshTokensRepository: Repository<RefreshTokenEntity>,
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    private readonly dataSource: DataSource,
  ) {}

  getGoogleAuthUrl() {
    const client = this.createGoogleClient();

    return client.generateAuthUrl({
      access_type: 'offline',
      scope: ['openid', 'email', 'profile'],
      prompt: 'consent',
      include_granted_scopes: true,
      response_type: 'code',
    });
  }

  async exchangeGoogleCode(code: string, requestMeta?: RequestMeta) {
    if (!code) {
      throw new BadRequestException('Missing Google authorization code.');
    }

    const client = this.createGoogleClient();
    const { tokens } = await client.getToken(code);

    if (!tokens.id_token) {
      throw new UnauthorizedException('Google did not return an id_token.');
    }

    const authResult = await this.signInWithGoogle(tokens.id_token, requestMeta);

    return {
      googleIdToken: tokens.id_token,
      ...authResult,
    };
  }

  async signInWithGoogle(idToken: string, requestMeta?: RequestMeta) {
    const googleClientId = this.configService.get<string>('GOOGLE_CLIENT_ID');

    if (!googleClientId) {
      throw new InternalServerErrorException('Missing GOOGLE_CLIENT_ID in environment.');
    }

    let payload: TokenPayload | undefined;
    const client = this.createGoogleClient();

    try {
      const ticket = await client.verifyIdToken({
        idToken,
        audience: googleClientId,
      });

      payload = ticket.getPayload();
    } catch {
      throw new UnauthorizedException('Invalid Google idToken.');
    }

    if (!payload || !payload.email) {
      throw new UnauthorizedException('Google token is missing email claim.');
    }

    if (!payload.email_verified) {
      throw new UnauthorizedException('Google email is not verified.');
    }

    const email = payload.email.toLowerCase().trim();
    const displayName = payload.name?.trim() || email.split('@')[0];
    const avatarUrl = payload.picture?.trim() || '';

    let user = await this.usersRepository.findOne({ where: { email } });

    if (!user) {
      user = this.usersRepository.create({
        email,
        displayName,
        avatarUrl,
        role: UserRole.USER,
      });
    } else {
      user.displayName = displayName;
      user.avatarUrl = avatarUrl;
    }

    const savedUser = await this.usersRepository.save(user);

    const { accessToken, refreshToken } = await this.issueTokenPair(savedUser, requestMeta);

    return {
      accessToken,
      refreshToken,
      user: {
        id: savedUser.id,
        email: savedUser.email,
        displayName: savedUser.displayName,
        avatarUrl: savedUser.avatarUrl,
        role: savedUser.role,
      },
    };
  }

  async refreshTokens(refreshToken: string, requestMeta?: RequestMeta) {
    if (!refreshToken) {
      throw new UnauthorizedException('Missing refresh token.');
    }

    const refreshTokenHash = this.hashRefreshToken(refreshToken);

    return this.dataSource.transaction(async (manager) => {
      const refreshTokenRepository = manager.getRepository(RefreshTokenEntity);
      const usersRepository = manager.getRepository(UserEntity);

      const tokenRecord = await refreshTokenRepository
        .createQueryBuilder('refreshToken')
        .setLock('pessimistic_write')
        .where('refreshToken.tokenHash = :refreshTokenHash', { refreshTokenHash })
        .getOne();

      if (!tokenRecord) {
        throw new UnauthorizedException('Invalid refresh token.');
      }

      if (tokenRecord.revokedAt) {
        throw new ForbiddenException('Refresh token has been revoked.');
      }

      if (tokenRecord.expiresAt.getTime() <= Date.now()) {
        tokenRecord.revokedAt = new Date();
        await refreshTokenRepository.save(tokenRecord);
        throw new UnauthorizedException('Refresh token expired.');
      }

      tokenRecord.revokedAt = new Date();
      await refreshTokenRepository.save(tokenRecord);

      const user = await usersRepository.findOne({ where: { id: tokenRecord.userId } });

      if (!user) {
        throw new UnauthorizedException('User not found for refresh token.');
      }

      const { accessToken, refreshToken: nextRefreshToken } = await this.issueTokenPairWithManager(
        user,
        manager,
        requestMeta,
      );

      return {
        accessToken,
        refreshToken: nextRefreshToken,
        user: {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          avatarUrl: user.avatarUrl,
          role: user.role,
        },
      };
    });
  }

  async revokeRefreshToken(refreshToken: string) {
    if (!refreshToken) {
      throw new UnauthorizedException('Missing refresh token.');
    }

    const refreshTokenHash = this.hashRefreshToken(refreshToken);
    const tokenRecord = await this.refreshTokensRepository.findOne({
      where: { tokenHash: refreshTokenHash },
    });

    if (!tokenRecord) {
      return;
    }

    if (!tokenRecord.revokedAt) {
      tokenRecord.revokedAt = new Date();
      await this.refreshTokensRepository.save(tokenRecord);
    }
  }

  private createGoogleClient() {
    const googleClientId = this.configService.get<string>('GOOGLE_CLIENT_ID');
    const googleClientSecret = this.configService.get<string>('GOOGLE_CLIENT_SECRET');
    const googleRedirectUri = this.configService.get<string>('GOOGLE_REDIRECT_URI');

    if (!googleClientId) {
      throw new InternalServerErrorException('Missing GOOGLE_CLIENT_ID in environment.');
    }

    if (!googleClientSecret) {
      throw new InternalServerErrorException('Missing GOOGLE_CLIENT_SECRET in environment.');
    }

    if (!googleRedirectUri) {
      throw new InternalServerErrorException('Missing GOOGLE_REDIRECT_URI in environment.');
    }

    return new OAuth2Client({
      clientId: googleClientId,
      clientSecret: googleClientSecret,
      redirectUri: googleRedirectUri,
    });
  }

  private async issueTokenPair(user: UserEntity, requestMeta?: RequestMeta) {
    return this.issueTokenPairWithManager(user, this.dataSource.manager, requestMeta);
  }

  private async issueTokenPairWithManager(
    user: UserEntity,
    manager: DataSource['manager'],
    requestMeta?: RequestMeta,
  ) {
    const accessTokenSecret =
      this.configService.get<string>('ACCESS_TOKEN_SECRET') ||
      this.configService.get<string>('JWT_SECRET');

    if (!accessTokenSecret) {
      throw new InternalServerErrorException('Missing ACCESS_TOKEN_SECRET or JWT_SECRET.');
    }

    const accessTokenExpiresInSeconds = Number(
      this.configService.get<string>('ACCESS_TOKEN_EXPIRES_IN_SECONDS') || '900',
    );
    const refreshTokenExpiresInSeconds = Number(
      this.configService.get<string>('REFRESH_TOKEN_EXPIRES_IN_SECONDS') || '2592000',
    );

    const safeAccessTtl =
      Number.isFinite(accessTokenExpiresInSeconds) && accessTokenExpiresInSeconds > 0
        ? accessTokenExpiresInSeconds
        : 900;
    const safeRefreshTtl =
      Number.isFinite(refreshTokenExpiresInSeconds) && refreshTokenExpiresInSeconds > 0
        ? refreshTokenExpiresInSeconds
        : 2592000;

    const accessToken = await this.jwtService.signAsync(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
      },
      {
        secret: accessTokenSecret,
        expiresIn: safeAccessTtl,
      },
    );

    const refreshToken = randomBytes(48).toString('base64url');
    const refreshTokenHash = this.hashRefreshToken(refreshToken);
    const expiresAt = new Date(Date.now() + safeRefreshTtl * 1000);

    const refreshTokenRepository = manager.getRepository(RefreshTokenEntity);
    const refreshTokenEntity = refreshTokenRepository.create({
      userId: user.id,
      tokenHash: refreshTokenHash,
      expiresAt,
      revokedAt: null,
      userAgent: requestMeta?.userAgent?.slice(0, 512) || null,
      ipAddress: requestMeta?.ipAddress?.slice(0, 64) || null,
    });

    await refreshTokenRepository.save(refreshTokenEntity);

    return {
      accessToken,
      refreshToken,
    };
  }

  private hashRefreshToken(refreshToken: string): string {
    const refreshTokenPepper =
      this.configService.get<string>('REFRESH_TOKEN_PEPPER') ||
      this.configService.get<string>('JWT_SECRET');

    if (!refreshTokenPepper) {
      throw new InternalServerErrorException('Missing REFRESH_TOKEN_PEPPER or JWT_SECRET.');
    }

    return createHmac('sha256', refreshTokenPepper).update(refreshToken).digest('hex');
  }
}
