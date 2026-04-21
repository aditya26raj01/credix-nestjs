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

const MAX_SYNC_WINDOW_DAYS = 2;

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
      throw new ConflictException(
        'A sync job is already running for this user.',
      );
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
    const fromDate =
      lastSuccessfulJob?.toDate || this.getInitialFromDate(toDate);

    const chunks = this.buildSyncWindows(
      fromDate,
      toDate,
      MAX_SYNC_WINDOW_DAYS,
    );
    const jobsToCreate = chunks.map(
      ({ fromDate: chunkFrom, toDate: chunkTo }) =>
        this.syncJobsRepository.create({
          userId,
          status: SyncJobStatus.PENDING,
          stage: SyncJobStage.FETCH,
          fromDate: chunkFrom,
          toDate: chunkTo,
          lastProcessedAt: null,
          errorMessage: null,
        }),
    );

    const savedJobs = await this.syncJobsRepository.save(jobsToCreate);

    try {
      for (const job of savedJobs) {
        await this.syncQueueService.publishFetchJob(job.id, job.userId);
      }
    } catch (error) {
      const message = this.formatErrorMessage(error);

      for (const job of savedJobs) {
        if (job.status === SyncJobStatus.SUCCESS) {
          continue;
        }

        job.status = SyncJobStatus.FAILED;
        job.errorMessage = message;
      }

      await this.syncJobsRepository.save(savedJobs);
      throw new ServiceUnavailableException(
        'Failed to enqueue one or more sync jobs.',
      );
    }

    return {
      userId,
      requestedFromDate: fromDate,
      requestedToDate: toDate,
      chunkSizeDays: MAX_SYNC_WINDOW_DAYS,
      totalJobs: savedJobs.length,
      jobs: savedJobs.map((job) => ({
        id: job.id,
        status: job.status,
        stage: job.stage,
        fromDate: job.fromDate,
        toDate: job.toDate,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      })),
    };
  }

  private buildSyncWindows(
    fromDate: Date,
    toDate: Date,
    maxWindowDays: number,
  ) {
    const windows: Array<{ fromDate: Date; toDate: Date }> = [];
    const maxWindowMs = maxWindowDays * 24 * 60 * 60 * 1000;

    let cursor = new Date(fromDate);

    while (cursor < toDate) {
      const nextEnd = new Date(
        Math.min(cursor.getTime() + maxWindowMs, toDate.getTime()),
      );
      windows.push({
        fromDate: new Date(cursor),
        toDate: nextEnd,
      });
      cursor = nextEnd;
    }

    if (windows.length === 0) {
      windows.push({
        fromDate,
        toDate,
      });
    }

    return windows;
  }

  private getInitialFromDate(now: Date) {
    const safeLookbackDays = this.appConfigService.getPositiveInt(
      'SYNC_INITIAL_LOOKBACK_DAYS',
      30,
    );

    return new Date(now.getTime() - safeLookbackDays * 24 * 60 * 60 * 1000);
  }

  private formatErrorMessage(error: unknown) {
    if (error instanceof Error) {
      return error.message.slice(0, 2000);
    }

    return 'Unknown error while publishing sync job to queue.';
  }
}
