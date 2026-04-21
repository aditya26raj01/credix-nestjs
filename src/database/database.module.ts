import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppConfigService } from '../config/app-config.service';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (appConfigService: AppConfigService) => {
        const databaseUrl = appConfigService.getRequiredString('DATABASE_URL');
        const dbSslEnabled = appConfigService.getBoolean('DB_SSL', true);
        const rejectUnauthorized = appConfigService.getBoolean(
          'DB_SSL_REJECT_UNAUTHORIZED',
          true,
        );

        return {
          type: 'postgres' as const,
          url: databaseUrl,
          autoLoadEntities: true,
          synchronize: appConfigService.getString('NODE_ENV') === 'development',
          ssl: dbSslEnabled ? { rejectUnauthorized } : false,
        };
      },
    }),
  ],
})
export class DatabaseModule {}
