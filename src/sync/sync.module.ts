import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { EmailJobEntity } from './email-job.entity';
import { SyncJobEntity } from './sync-job.entity';
import { SyncController } from './sync.controller';
import { SyncQueueService } from './sync-queue.service';
import { SyncService } from './sync.service';

@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([SyncJobEntity, EmailJobEntity]),
  ],
  controllers: [SyncController],
  providers: [SyncService, SyncQueueService],
})
export class SyncModule {}
