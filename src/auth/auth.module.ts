import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from '../user/user.entity';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OAuthConnectionEntity } from './oauth-connection.entity';
import { RefreshTokenEntity } from './refresh-token.entity';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { TokenService } from './token.service';
import { JwtService } from '@nestjs/jwt';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      UserEntity,
      RefreshTokenEntity,
      OAuthConnectionEntity,
    ]),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, TokenService, JwtService],
  exports: [JwtAuthGuard, TokenService],
})
export class AuthModule {}
