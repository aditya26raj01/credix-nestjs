import { DataSource } from 'typeorm';
import { SyncJobEntity, SyncJobStage, SyncJobStatus } from '../../sync/sync-job.entity';

interface SqsRecord {
  messageId: string;
  body: string;
}

interface SqsEvent {
  Records: SqsRecord[];
}

interface ProcessQueueMessage {
  jobId: string;
  userId: string;
  stage: SyncJobStage;
}

let dataSource: DataSource | null = null;

export const handler = async (event: SqsEvent): Promise<void> => {
  for (const record of event.Records) {
    const message = parseMessage(record.body);
    await processProcessMessage(message);
  }
};

const processProcessMessage = async (message: ProcessQueueMessage): Promise<void> => {
  const ds = await getDataSource();

  await ds.transaction(async (manager) => {
    const repo = manager.getRepository(SyncJobEntity);

    const job = await repo
      .createQueryBuilder('job')
      .setLock('pessimistic_write')
      .where('job.id = :jobId', { jobId: message.jobId })
      .getOne();

    if (!job) {
      throw new Error(`SyncJob not found for jobId=${message.jobId}`);
    }

    if (job.userId !== message.userId) {
      throw new Error(`SyncJob user mismatch for jobId=${message.jobId}`);
    }

    if (job.stage !== SyncJobStage.PROCESS) {
      return;
    }

    if (job.status === SyncJobStatus.SUCCESS || job.status === SyncJobStatus.FAILED) {
      return;
    }

    if (job.status === SyncJobStatus.PENDING) {
      job.status = SyncJobStatus.RUNNING;
      job.errorMessage = null;
      await repo.save(job);
    }
  });

  try {
    await runProcessStep(message.jobId);

    await ds.transaction(async (manager) => {
      const repo = manager.getRepository(SyncJobEntity);
      const job = await repo
        .createQueryBuilder('job')
        .setLock('pessimistic_write')
        .where('job.id = :jobId', { jobId: message.jobId })
        .getOne();

      if (!job) {
        throw new Error(`SyncJob missing before success transition. jobId=${message.jobId}`);
      }

      if (job.stage !== SyncJobStage.PROCESS) {
        return;
      }

      job.status = SyncJobStatus.SUCCESS;
      job.lastProcessedAt = new Date();
      job.errorMessage = null;
      await repo.save(job);
    });
  } catch (error) {
    await markJobFailed(message.jobId, error);
    throw error;
  }
};

const runProcessStep = async (jobId: string): Promise<void> => {
  // TODO: Replace with LLM transaction extraction + DB persistence implementation.
  // Keep this function idempotent using jobId for dedupe keys.
  void jobId;
};

const markJobFailed = async (jobId: string, error: unknown): Promise<void> => {
  const ds = await getDataSource();
  const repo = ds.getRepository(SyncJobEntity);
  const job = await repo.findOne({ where: { id: jobId } });

  if (!job) {
    return;
  }

  job.status = SyncJobStatus.FAILED;
  job.errorMessage = formatError(error);
  await repo.save(job);
};

const parseMessage = (rawBody: string): ProcessQueueMessage => {
  const parsed = JSON.parse(rawBody) as Partial<ProcessQueueMessage>;

  if (!parsed.jobId || !parsed.userId || !parsed.stage) {
    throw new Error('Invalid process queue message payload.');
  }

  if (parsed.stage !== SyncJobStage.PROCESS) {
    throw new Error(`Process worker received unsupported stage=${parsed.stage}`);
  }

  return {
    jobId: parsed.jobId,
    userId: parsed.userId,
    stage: parsed.stage,
  };
};

const getDataSource = async (): Promise<DataSource> => {
  if (dataSource && dataSource.isInitialized) {
    return dataSource;
  }

  const dbSslEnabled = parseBooleanEnv('DB_SSL', true);
  const dbRejectUnauthorized = parseBooleanEnv('DB_SSL_REJECT_UNAUTHORIZED', true);

  dataSource = new DataSource({
    type: 'postgres',
    url: getRequiredEnv('DATABASE_URL'),
    entities: [SyncJobEntity],
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

  return 'Unknown process worker error.';
};
