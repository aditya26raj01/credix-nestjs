import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from '../user/user.entity';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OAuthConnectionEntity } from './oauth-connection.entity';
import { RefreshTokenEntity } from './refresh-token.entity';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { TokenService } from './token.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserEntity, RefreshTokenEntity, OAuthConnectionEntity]),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const jwtSecret = configService.get<string>('JWT_SECRET');
        const jwtExpiresInSeconds = Number(
          configService.get<string>('JWT_EXPIRES_IN_SECONDS') || '604800',
        );

        if (!jwtSecret) {
          throw new Error('Missing JWT_SECRET. Add it to .env.local or your environment.');
        }

        return {
          secret: jwtSecret,
          signOptions: {
            expiresIn:
              Number.isFinite(jwtExpiresInSeconds) && jwtExpiresInSeconds > 0
                ? jwtExpiresInSeconds
                : 604800,
          },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, TokenService],
})
export class AuthModule {}
