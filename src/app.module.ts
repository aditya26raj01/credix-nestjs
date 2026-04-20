import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { AppConfigModule } from './config/app-config.module';
import { DatabaseModule } from './database/database.module';
import { SyncModule } from './sync/sync.module';

@Module({
  imports: [AppConfigModule, DatabaseModule, AuthModule, SyncModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
