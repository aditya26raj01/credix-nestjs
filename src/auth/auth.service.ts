import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Credentials, OAuth2Client, TokenPayload } from 'google-auth-library';
import { DataSource, Repository } from 'typeorm';
import { AppConfigService } from '../config/app-config.service';
import { OAuthConnectionEntity, OAuthProvider } from './oauth-connection.entity';
import { RefreshTokenEntity } from './refresh-token.entity';
import { TokenService } from './token.service';
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
    @InjectRepository(OAuthConnectionEntity)
    private readonly oauthConnectionsRepository: Repository<OAuthConnectionEntity>,
    private readonly appConfigService: AppConfigService,
    private readonly tokenService: TokenService,
    private readonly dataSource: DataSource,
  ) {}

  getGoogleAuthUrl() {
    const client = this.createGoogleOAuthClient();

    return client.generateAuthUrl({
      access_type: 'offline',
      scope: this.getGoogleScopes(),
      prompt: 'consent',
      include_granted_scopes: true,
      response_type: 'code',
    });
  }

  async exchangeGoogleCode(code: string, requestMeta?: RequestMeta) {
    if (!code) {
      throw new BadRequestException('Missing Google authorization code.');
    }

    const client = this.createGoogleOAuthClient();
    const { tokens } = await client.getToken(code);

    if (!tokens.id_token) {
      throw new UnauthorizedException('Google did not return an id_token.');
    }

    const payload = await this.verifyGoogleIdToken(tokens.id_token);
    const user = await this.upsertGoogleUser(payload);

    await this.upsertGoogleOAuthConnection(user, payload, tokens);

    const authResult = await this.issueAppSession(user, requestMeta);

    return {
      ...authResult,
      googleIdToken: tokens.id_token,
      googleConnection: {
        ...authResult.googleConnection,
        connected: true,
        provider: OAuthProvider.GOOGLE,
        email: payload.email,
        scope: tokens.scope || this.getGoogleScopes().join(' '),
      },
    };
  }

  async signInWithGoogle(idToken: string, requestMeta?: RequestMeta) {
    const payload = await this.verifyGoogleIdToken(idToken);
    const user = await this.upsertGoogleUser(payload);

    return this.issueAppSession(user, requestMeta);
  }

  async refreshTokens(refreshToken: string, requestMeta?: RequestMeta) {
    const refreshTokenHash = this.tokenService.hashRefreshToken(
      this.ensureRefreshTokenInput(refreshToken),
    );

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
        user: this.serializeUser(user),
      };
    });
  }

  async revokeRefreshToken(refreshToken: string) {
    const refreshTokenHash = this.tokenService.hashRefreshToken(
      this.ensureRefreshTokenInput(refreshToken),
    );
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

  private async issueAppSession(user: UserEntity, requestMeta?: RequestMeta) {
    const { accessToken, refreshToken } = await this.issueTokenPair(user, requestMeta);
    const googleConnection = await this.oauthConnectionsRepository.findOne({
      where: {
        userId: user.id,
        provider: OAuthProvider.GOOGLE,
      },
    });

    return {
      accessToken,
      refreshToken,
      user: this.serializeUser(user),
      googleConnection: {
        connected: Boolean(googleConnection && !googleConnection.revokedAt),
        provider: OAuthProvider.GOOGLE,
        email: googleConnection?.providerEmail || null,
        scope: googleConnection?.scope || null,
      },
    };
  }

  private async verifyGoogleIdToken(idToken: string): Promise<TokenPayload> {
    const googleClientId = this.getGoogleClientId();

    const client = this.createGoogleVerifierClient();

    try {
      const ticket = await client.verifyIdToken({
        idToken,
        audience: googleClientId,
      });
      const payload = ticket.getPayload();

      if (!payload || !payload.email) {
        throw new UnauthorizedException('Google token is missing email claim.');
      }

      if (!payload.email_verified) {
        throw new UnauthorizedException('Google email is not verified.');
      }

      return payload;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }

      throw new UnauthorizedException('Invalid Google idToken.');
    }
  }

  private async upsertGoogleUser(payload: TokenPayload) {
    const email = payload.email!.toLowerCase().trim();
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

    return this.usersRepository.save(user);
  }

  private async upsertGoogleOAuthConnection(
    user: UserEntity,
    payload: TokenPayload,
    tokens: Credentials,
  ) {
    if (!payload.sub || !payload.email) {
      throw new UnauthorizedException('Google token is missing required account claims.');
    }

    const existing = await this.oauthConnectionsRepository.findOne({
      where: {
        userId: user.id,
        provider: OAuthProvider.GOOGLE,
      },
    });

    const refreshTokenEncrypted = tokens.refresh_token
      ? this.tokenService.encryptOpaqueToken(tokens.refresh_token)
      : existing?.refreshTokenEncrypted || null;

    if (!refreshTokenEncrypted) {
      throw new ConflictException(
        'Missing Google refresh token. Re-consent with prompt=consent and access_type=offline.',
      );
    }

    const connection =
      existing ||
      this.oauthConnectionsRepository.create({
        userId: user.id,
        provider: OAuthProvider.GOOGLE,
      });

    connection.providerAccountId = payload.sub;
    connection.providerEmail = payload.email.toLowerCase().trim();
    connection.refreshTokenEncrypted = refreshTokenEncrypted;
    connection.accessTokenEncrypted = tokens.access_token
      ? this.tokenService.encryptOpaqueToken(tokens.access_token)
      : existing?.accessTokenEncrypted || null;
    connection.accessTokenExpiresAt = tokens.expiry_date
      ? new Date(tokens.expiry_date)
      : existing?.accessTokenExpiresAt || null;
    connection.scope = tokens.scope || existing?.scope || this.getGoogleScopes().join(' ');
    connection.tokenType = tokens.token_type || existing?.tokenType || null;
    connection.revokedAt = null;

    return this.oauthConnectionsRepository.save(connection);
  }

  private createGoogleOAuthClient() {
    const googleClientId = this.getGoogleClientId();
    const googleClientSecret = this.appConfigService.getRequiredString('GOOGLE_CLIENT_SECRET');
    const googleRedirectUri = this.appConfigService.getRequiredString('GOOGLE_REDIRECT_URI');

    return new OAuth2Client({
      clientId: googleClientId,
      clientSecret: googleClientSecret,
      redirectUri: googleRedirectUri,
    });
  }

  private createGoogleVerifierClient() {
    return new OAuth2Client(this.getGoogleClientId());
  }

  private getGoogleClientId() {
    return this.appConfigService.getRequiredString('GOOGLE_CLIENT_ID');
  }

  private getGoogleScopes() {
    return this.appConfigService.getStringArray('GOOGLE_OAUTH_SCOPES', [
      'openid',
      'email',
      'profile',
      'https://www.googleapis.com/auth/gmail.readonly',
    ]);
  }

  private async issueTokenPair(user: UserEntity, requestMeta?: RequestMeta) {
    return this.issueTokenPairWithManager(user, this.dataSource.manager, requestMeta);
  }

  private async issueTokenPairWithManager(
    user: UserEntity,
    manager: DataSource['manager'],
    requestMeta?: RequestMeta,
  ) {
    const accessToken = await this.tokenService.signAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role,
    });

    const refreshToken = this.tokenService.generateRefreshToken();
    const refreshTokenHash = this.tokenService.hashRefreshToken(refreshToken);
    const expiresAt = new Date(Date.now() + this.tokenService.getRefreshTokenTtlSeconds() * 1000);

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

  private serializeUser(user: UserEntity) {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      role: user.role,
    };
  }

  private ensureRefreshTokenInput(refreshToken: string) {
    if (!refreshToken) {
      throw new UnauthorizedException('Missing refresh token.');
    }

    return refreshToken;
  }
}
