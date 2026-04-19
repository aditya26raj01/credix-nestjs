import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

const parseBoolean = (value: string | undefined, defaultValue: boolean): boolean => {
  if (value === undefined) {
    return defaultValue;
  }

  return value.toLowerCase() === 'true';
};

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const databaseUrl = configService.get<string>('DATABASE_URL');
        const dbSslEnabled = parseBoolean(configService.get<string>('DB_SSL'), true);
        const rejectUnauthorized = parseBoolean(
          configService.get<string>('DB_SSL_REJECT_UNAUTHORIZED'),
          true,
        );

        if (!databaseUrl) {
          throw new Error('Missing DATABASE_URL. Add it to .env.local or your environment.');
        }

        return {
          type: 'postgres' as const,
          url: databaseUrl,
          autoLoadEntities: true,
          synchronize: configService.get<string>('NODE_ENV') === 'development',
          ssl: dbSslEnabled ? { rejectUnauthorized } : false,
        };
      },
    }),
  ],
})
export class DatabaseModule {}
