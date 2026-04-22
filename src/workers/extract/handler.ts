import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { EmailJobEntity, EmailJobStatus } from 'src/sync/email-job.entity';
import { DataSource } from 'typeorm';

interface SqsRecord {
  messageId: string;
  body: string;
}

interface SqsEvent {
  Records: SqsRecord[];
}

interface ExtractQueueMessage {
  jobId: string;
  userId: string;
}

const sqsClient = new SQSClient({
  region: getRequiredEnv('AWS_REGION'),
});

let dataSource: DataSource | null = null;

export const handler = async (event: SqsEvent): Promise<void> => {
  for (const record of event.Records) {
    console.info(
      `[extract-worker] received record messageId=${record.messageId}`,
    );
    const message = parseMessage(record.body);
    console.info(
      `[extract-worker] parsed message jobId=${message.jobId} userId=${message.userId}`,
    );

    try {
      await processExtractMessage(message);
      console.info(
        `[extract-worker] completed message jobId=${message.jobId} userId=${message.userId}`,
      );
    } catch (error) {
      console.error(
        `[extract-worker] failed message jobId=${message.jobId} userId=${message.userId} error=${formatError(error)}`,
      );
      throw error;
    }
  }
};

const processExtractMessage = async (
  message: ExtractQueueMessage,
): Promise<void> => {
  console.info(
    `[extract-worker] processExtractMessage start jobId=${message.jobId} userId=${message.userId}`,
  );
  const ds = await getDataSource();

  await ds.transaction(async (manager) => {
    const repo = manager.getRepository(EmailJobEntity);

    const job = await repo
      .createQueryBuilder('job')
      .setLock('pessimistic_write')
      .where('job.id = :jobId', { jobId: message.jobId })
      .getOne();

    if (!job) {
      throw new Error(`EmailJob not found for jobId=${message.jobId}`);
    }

    if (job.userId !== message.userId) {
      throw new Error(`EmailJob user mismatch for jobId=${message.jobId}`);
    }

    if (
      job.status === EmailJobStatus.SUCCESS ||
      job.status === EmailJobStatus.FAILED
    ) {
      console.info(
        `[extract-worker] skipping jobId=${message.jobId} because status=${job.status}`,
      );
      return;
    }

    if (job.status === EmailJobStatus.PENDING) {
      job.status = EmailJobStatus.RUNNING;
      job.errorMessage = null;
      await repo.save(job);
      console.info(`[extract-worker] marked RUNNING jobId=${message.jobId}`);
    }
  });

  try {
    console.info(
      `[extract-worker] runExtractStep start jobId=${message.jobId}`,
    );
    await runExtractStep(message.jobId);
    console.info(
      `[extract-worker] runExtractStep complete jobId=${message.jobId}`,
    );

    await ds.transaction(async (manager) => {
      const repo = manager.getRepository(EmailJobEntity);
      const job = await repo
        .createQueryBuilder('job')
        .setLock('pessimistic_write')
        .where('job.id = :jobId', { jobId: message.jobId })
        .getOne();

      if (!job) {
        throw new Error(
          `EmailJob missing before stage transition. jobId=${message.jobId}`,
        );
      }

      job.status = EmailJobStatus.SUCCESS;
      await repo.save(job);
      console.info(`[extract-worker] completed jobId=${message.jobId}`);
    });

    console.info(
      `[extract-worker] publishing process message jobId=${message.jobId} userId=${message.userId}`,
    );
    await publishProcessStageMessage(message.jobId, message.userId);
    console.info(
      `[extract-worker] published process message jobId=${message.jobId} userId=${message.userId}`,
    );
  } catch (error) {
    console.error(
      `[extract-worker] processExtractMessage error jobId=${message.jobId} userId=${message.userId} error=${formatError(error)}`,
    );
    await markJobFailed(message.jobId, error);
    throw error;
  }
};

const runExtractStep = async (jobId: string): Promise<void> => {
  // TODO: Replace with PDF/text extraction implementation.
  // Keep this function idempotent using jobId as source partition.
  void jobId;
};

const publishProcessStageMessage = async (
  jobId: string,
  userId: string,
): Promise<void> => {
  const queueUrl = getRequiredEnv('SYNC_PROCESS_QUEUE_URL');

  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({
        jobId,
        userId,
      }),
    }),
  );
  console.info(
    `[extract-worker] sent process queue message jobId=${jobId} userId=${userId}`,
  );
};

const markJobFailed = async (jobId: string, error: unknown): Promise<void> => {
  const ds = await getDataSource();
  const repo = ds.getRepository(EmailJobEntity);
  const job = await repo.findOne({ where: { id: jobId } });

  if (!job) {
    return;
  }

  job.status = EmailJobStatus.FAILED;
  job.errorMessage = formatError(error);
  await repo.save(job);
  console.error(
    `[extract-worker] marked job FAILED jobId=${jobId} error=${job.errorMessage}`,
  );
};

const parseMessage = (rawBody: string): ExtractQueueMessage => {
  const parsed = JSON.parse(rawBody) as Partial<ExtractQueueMessage>;

  if (!parsed.jobId || !parsed.userId) {
    throw new Error('Invalid extract queue message payload.');
  }

  return {
    jobId: parsed.jobId,
    userId: parsed.userId,
  };
};

const getDataSource = async (): Promise<DataSource> => {
  if (dataSource && dataSource.isInitialized) {
    return dataSource;
  }

  const dbSslEnabled = parseBooleanEnv('DB_SSL', true);
  const dbRejectUnauthorized = parseBooleanEnv(
    'DB_SSL_REJECT_UNAUTHORIZED',
    true,
  );

  dataSource = new DataSource({
    type: 'postgres',
    url: getRequiredEnv('DATABASE_URL'),
    entities: [EmailJobEntity],
    synchronize: false,
    ssl: dbSslEnabled ? { rejectUnauthorized: dbRejectUnauthorized } : false,
  });

  await dataSource.initialize();
  return dataSource;
};

function parseBooleanEnv(key: string, fallback: boolean): boolean {
  const raw = process.env[key];

  if (!raw) {
    return fallback;
  }

  return raw.trim().toLowerCase() === 'true';
}

function getRequiredEnv(key: string): string {
  const value = process.env[key];

  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${key}`);
  }

  return value.trim();
}

const formatError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message.slice(0, 2000);
  }

  return 'Unknown extract worker error.';
};
