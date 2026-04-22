// import { DataSource } from 'typeorm';
// import {
//   EmailJobEntity,
//   EmailJobStage,
//   EmailJobStatus,
// } from '../../sync/email-job.entity';
// import { SyncJobStage } from '../../sync/sync-job.entity';

// interface SqsRecord {
//   messageId: string;
//   body: string;
// }

// interface SqsEvent {
//   Records: SqsRecord[];
// }

// interface ProcessQueueMessage {
//   jobId: string;
//   userId: string;
//   stage: SyncJobStage;
// }

// let dataSource: DataSource | null = null;

// export const handler = async (event: SqsEvent): Promise<void> => {
//   for (const record of event.Records) {
//     console.info(
//       `[process-worker] received record messageId=${record.messageId}`,
//     );
//     const message = parseMessage(record.body);
//     console.info(
//       `[process-worker] parsed message jobId=${message.jobId} userId=${message.userId} stage=${message.stage}`,
//     );

//     try {
//       await processProcessMessage(message);
//       console.info(
//         `[process-worker] completed message jobId=${message.jobId} userId=${message.userId}`,
//       );
//     } catch (error) {
//       console.error(
//         `[process-worker] failed message jobId=${message.jobId} userId=${message.userId} error=${formatError(error)}`,
//       );
//       throw error;
//     }
//   }
// };

// const processProcessMessage = async (
//   message: ProcessQueueMessage,
// ): Promise<void> => {
//   console.info(
//     `[process-worker] processProcessMessage start jobId=${message.jobId} userId=${message.userId}`,
//   );
//   const ds = await getDataSource();

//   await ds.transaction(async (manager) => {
//     const repo = manager.getRepository(EmailJobEntity);

//     const emailJob = await repo
//       .createQueryBuilder('emailJob')
//       .setLock('pessimistic_write')
//       .where('emailJob.id = :jobId', { jobId: message.jobId })
//       .getOne();

//     if (!emailJob) {
//       throw new Error(`EmailJob not found for jobId=${message.jobId}`);
//     }

//     if (emailJob.userId !== message.userId) {
//       throw new Error(`EmailJob user mismatch for jobId=${message.jobId}`);
//     }

//     if (emailJob.stage !== EmailJobStage.PROCESS) {
//       console.info(
//         `[process-worker] skipping jobId=${message.jobId} because stage=${emailJob.stage}`,
//       );
//       return;
//     }

//     if (
//       emailJob.status === EmailJobStatus.SUCCESS ||
//       emailJob.status === EmailJobStatus.FAILED
//     ) {
//       console.info(
//         `[process-worker] skipping jobId=${message.jobId} because status=${emailJob.status}`,
//       );
//       return;
//     }

//     if (emailJob.status === EmailJobStatus.PENDING) {
//       emailJob.status = EmailJobStatus.RUNNING;
//       emailJob.errorMessage = null;
//       await repo.save(emailJob);
//       console.info(
//         `[process-worker] marked RUNNING jobId=${message.jobId} stage=${emailJob.stage}`,
//       );
//     }
//   });

//   try {
//     console.info(
//       `[process-worker] runProcessStep start jobId=${message.jobId}`,
//     );
//     await runProcessStep(message.jobId);
//     console.info(
//       `[process-worker] runProcessStep complete jobId=${message.jobId}`,
//     );

//     await ds.transaction(async (manager) => {
//       const repo = manager.getRepository(EmailJobEntity);
//       const emailJob = await repo
//         .createQueryBuilder('emailJob')
//         .setLock('pessimistic_write')
//         .where('emailJob.id = :jobId', { jobId: message.jobId })
//         .getOne();

//       if (!emailJob) {
//         throw new Error(
//           `EmailJob missing before success transition. jobId=${message.jobId}`,
//         );
//       }

//       if (emailJob.stage !== EmailJobStage.PROCESS) {
//         console.info(
//           `[process-worker] skip completion for jobId=${message.jobId} because stage=${emailJob.stage}`,
//         );
//         return;
//       }

//       emailJob.stage = EmailJobStage.COMPLETE;
//       emailJob.status = EmailJobStatus.SUCCESS;
//       emailJob.errorMessage = null;
//       await repo.save(emailJob);
//       console.info(
//         `[process-worker] marked SUCCESS jobId=${message.jobId} stage=${emailJob.stage}`,
//       );
//     });
//   } catch (error) {
//     console.error(
//       `[process-worker] processProcessMessage error jobId=${message.jobId} userId=${message.userId} error=${formatError(error)}`,
//     );
//     await markJobFailed(message.jobId, error);
//     throw error;
//   }
// };

// const runProcessStep = async (jobId: string): Promise<void> => {
//   // TODO: Replace with LLM transaction extraction + DB persistence implementation.
//   // Keep this function idempotent using jobId for dedupe keys.
//   void jobId;
// };

// const markJobFailed = async (jobId: string, error: unknown): Promise<void> => {
//   const ds = await getDataSource();
//   const repo = ds.getRepository(EmailJobEntity);
//   const job = await repo.findOne({ where: { id: jobId } });

//   if (!job) {
//     return;
//   }

//   job.status = EmailJobStatus.FAILED;
//   job.errorMessage = formatError(error);
//   await repo.save(job);
//   console.error(
//     `[process-worker] marked job FAILED jobId=${jobId} error=${job.errorMessage}`,
//   );
// };

// const parseMessage = (rawBody: string): ProcessQueueMessage => {
//   const parsed = JSON.parse(rawBody) as Partial<ProcessQueueMessage>;

//   if (!parsed.jobId || !parsed.userId || !parsed.stage) {
//     throw new Error('Invalid process queue message payload.');
//   }

//   if (parsed.stage !== SyncJobStage.PROCESS) {
//     throw new Error(
//       `Process worker received unsupported stage=${parsed.stage}`,
//     );
//   }

//   return {
//     jobId: parsed.jobId,
//     userId: parsed.userId,
//     stage: parsed.stage,
//   };
// };

// const getDataSource = async (): Promise<DataSource> => {
//   if (dataSource && dataSource.isInitialized) {
//     return dataSource;
//   }

//   const dbSslEnabled = parseBooleanEnv('DB_SSL', true);
//   const dbRejectUnauthorized = parseBooleanEnv(
//     'DB_SSL_REJECT_UNAUTHORIZED',
//     true,
//   );

//   dataSource = new DataSource({
//     type: 'postgres',
//     url: getRequiredEnv('DATABASE_URL'),
//     entities: [EmailJobEntity],
//     synchronize: false,
//     ssl: dbSslEnabled ? { rejectUnauthorized: dbRejectUnauthorized } : false,
//   });

//   await dataSource.initialize();
//   return dataSource;
// };

// function parseBooleanEnv(key: string, fallback: boolean): boolean {
//   const raw = process.env[key];

//   if (!raw) {
//     return fallback;
//   }

//   return raw.trim().toLowerCase() === 'true';
// }

// function getRequiredEnv(key: string): string {
//   const value = process.env[key];

//   if (!value || !value.trim()) {
//     throw new Error(`Missing required environment variable: ${key}`);
//   }

//   return value.trim();
// }

// const formatError = (error: unknown): string => {
//   if (error instanceof Error) {
//     return error.message.slice(0, 2000);
//   }

//   return 'Unknown process worker error.';
// };
