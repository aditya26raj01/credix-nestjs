import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { AppConfigService } from '../config/app-config.service';
import { SyncJobStage } from './sync-job.entity';

interface PublishStageJobInput {
  jobId: string;
  userId: string;
  stage: SyncJobStage;
}

@Injectable()
export class SyncQueueService {
  private readonly sqsClient: SQSClient;
  private readonly queueUrlsByStage: Record<SyncJobStage, string>;

  constructor(private readonly appConfigService: AppConfigService) {
    const region = this.appConfigService.getString('AWS_REGION') || 'ap-south-1';
    const fetchQueueUrl =
      this.appConfigService.getString('SYNC_FETCH_QUEUE_URL') ||
      this.appConfigService.getString('SQS_SYNC_FETCH_QUEUE_URL') ||
      '';
    const extractQueueUrl =
      this.appConfigService.getString('SYNC_EXTRACT_QUEUE_URL') ||
      this.appConfigService.getString('SQS_SYNC_EXTRACT_QUEUE_URL') ||
      '';
    const processQueueUrl =
      this.appConfigService.getString('SYNC_PROCESS_QUEUE_URL') ||
      this.appConfigService.getString('SQS_SYNC_PROCESS_QUEUE_URL') ||
      '';

    this.queueUrlsByStage = {
      [SyncJobStage.FETCH]: fetchQueueUrl,
      [SyncJobStage.EXTRACT]: extractQueueUrl,
      [SyncJobStage.PROCESS]: processQueueUrl,
    };

    if (!fetchQueueUrl) {
      throw new InternalServerErrorException(
        'Missing SYNC_FETCH_QUEUE_URL or SQS_SYNC_FETCH_QUEUE_URL in environment.',
      );
    }

    this.sqsClient = new SQSClient({ region });
  }

  async publishStageJob(input: PublishStageJobInput) {
    const queueUrl = this.queueUrlsByStage[input.stage];

    if (!queueUrl) {
      throw new InternalServerErrorException(
        `Missing queue URL configuration for stage ${input.stage}.`,
      );
    }

    await this.sqsClient.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({
          jobId: input.jobId,
          userId: input.userId,
          stage: input.stage,
        }),
      }),
    );
  }

  async publishFetchJob(jobId: string, userId: string) {
    await this.publishStageJob({
      jobId,
      userId,
      stage: SyncJobStage.FETCH,
    });
  }
}
