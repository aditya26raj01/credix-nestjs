import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { UserModule } from '../user/user.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({
  imports: [
    UserModule,
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
  providers: [AuthService],
})
export class AuthModule {}
