import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { OAuth2Client, TokenPayload } from 'google-auth-library';
import { Repository } from 'typeorm';
import { UserEntity, UserRole } from '../user/user.entity';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly usersRepository: Repository<UserEntity>,
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
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

  async exchangeGoogleCode(code: string) {
    if (!code) {
      throw new BadRequestException('Missing Google authorization code.');
    }

    const client = this.createGoogleClient();
    const { tokens } = await client.getToken(code);

    if (!tokens.id_token) {
      throw new UnauthorizedException('Google did not return an id_token.');
    }

    const authResult = await this.signInWithGoogle(tokens.id_token);

    return {
      googleIdToken: tokens.id_token,
      ...authResult,
    };
  }

  async signInWithGoogle(idToken: string) {
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

    const accessToken = await this.jwtService.signAsync({
      sub: savedUser.id,
      email: savedUser.email,
      role: savedUser.role,
    });

    return {
      accessToken,
      user: {
        id: savedUser.id,
        email: savedUser.email,
        displayName: savedUser.displayName,
        avatarUrl: savedUser.avatarUrl,
        role: savedUser.role,
      },
    };
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
}
