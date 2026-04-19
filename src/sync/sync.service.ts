import {
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppConfigService } from '../config/app-config.service';
import { SyncJobEntity, SyncJobStage, SyncJobStatus } from './sync-job.entity';
import { SyncQueueService } from './sync-queue.service';

@Injectable()
export class SyncService {
  constructor(
    @InjectRepository(SyncJobEntity)
    private readonly syncJobsRepository: Repository<SyncJobEntity>,
    private readonly syncQueueService: SyncQueueService,
    private readonly appConfigService: AppConfigService,
  ) {}

  async startSync(userId: string) {
    const runningJob = await this.syncJobsRepository.findOne({
      where: {
        userId,
        status: SyncJobStatus.RUNNING,
      },
    });

    if (runningJob) {
      throw new ConflictException('A sync job is already running for this user.');
    }

    const lastSuccessfulJob = await this.syncJobsRepository.findOne({
      where: {
        userId,
        status: SyncJobStatus.SUCCESS,
      },
      order: {
        toDate: 'DESC',
      },
    });

    const toDate = new Date();
    const fromDate = lastSuccessfulJob?.toDate || this.getInitialFromDate(toDate);

    const syncJob = this.syncJobsRepository.create({
      userId,
      status: SyncJobStatus.PENDING,
      stage: SyncJobStage.FETCH,
      fromDate,
      toDate,
      lastProcessedAt: null,
      errorMessage: null,
    });

    const savedJob = await this.syncJobsRepository.save(syncJob);

    try {
      await this.syncQueueService.publishFetchJob(savedJob.id, savedJob.userId);
    } catch (error) {
      savedJob.status = SyncJobStatus.FAILED;
      savedJob.errorMessage = this.formatErrorMessage(error);
      await this.syncJobsRepository.save(savedJob);
      throw new ServiceUnavailableException('Failed to enqueue sync job.');
    }

    return {
      id: savedJob.id,
      userId: savedJob.userId,
      status: savedJob.status,
      stage: savedJob.stage,
      fromDate: savedJob.fromDate,
      toDate: savedJob.toDate,
      createdAt: savedJob.createdAt,
      updatedAt: savedJob.updatedAt,
    };
  }

  private getInitialFromDate(now: Date) {
    const safeLookbackDays = this.appConfigService.getPositiveInt('SYNC_INITIAL_LOOKBACK_DAYS', 30);

    return new Date(now.getTime() - safeLookbackDays * 24 * 60 * 60 * 1000);
  }

  private formatErrorMessage(error: unknown) {
    if (error instanceof Error) {
      return error.message.slice(0, 2000);
    }

    return 'Unknown error while publishing sync job to queue.';
  }
}
