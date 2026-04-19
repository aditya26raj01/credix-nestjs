import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppConfigService } from '../config/app-config.service';
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
      inject: [AppConfigService],
      useFactory: (appConfigService: AppConfigService) => {
        return {
          secret: appConfigService.getRequiredString('JWT_SECRET'),
          signOptions: {
            expiresIn: appConfigService.getPositiveInt('JWT_EXPIRES_IN_SECONDS', 604800),
          },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, TokenService],
  exports: [JwtAuthGuard, TokenService],
})
export class AuthModule {}
