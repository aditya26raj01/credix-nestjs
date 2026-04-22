import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { OAuth2Client } from 'google-auth-library';
import { createDecipheriv, createHash } from 'crypto';
import { DataSource, In } from 'typeorm';
import { EmailJobEntity, EmailJobStatus } from '../../sync/email-job.entity';
import {
  OAuthConnectionEntity,
  OAuthProvider,
} from '../../auth/oauth-connection.entity';
import {
  SyncJobEntity,
  SyncJobStage,
  SyncJobStatus,
} from '../../sync/sync-job.entity';
import { UserEntity } from '../../user/user.entity';
import pLimit from 'p-limit';

interface SqsRecord {
  messageId: string;
  body: string;
}

interface SqsEvent {
  Records: SqsRecord[];
}

interface FetchQueueMessage {
  jobId: string;
  userId: string;
  stage: SyncJobStage;
}

interface GmailMessageReference {
  id: string;
  threadId: string;
}

interface GmailListResponse {
  messages?: GmailMessageReference[];
  nextPageToken?: string;
}

interface GmailMessagePartBody {
  attachmentId?: string;
  data?: string;
  size?: number;
}

interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: GmailMessagePartBody;
  parts?: GmailMessagePart[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  sizeEstimate?: number;
  payload?: GmailMessagePart;
}

interface GmailAttachmentResponse {
  data?: string;
  size?: number;
}

interface RawEmailRecord {
  id: string;
  threadId: string;
  snippet: string;
  internalDate: string | null;
  labels: string[];
  from: string | null;
  to: string | null;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  hasPdfAttachment: boolean;
  pdfAttachmentFilename: string | null;
}

interface EmailJobSeed {
  emailId: string;
  s3RawKey: string;
  s3AttachmentKey: string | null;
}

const CARD_KEYWORD_REGEX =
  /\b(credit\s*card|card\s*statement|visa|mastercard|master\s*card|amex|american\s*express|rupay)\b/i;
const STATEMENT_KEYWORD_REGEX =
  /\b(statement|e-?statement|bill|billing|minimum\s+due|total\s+due|payment\s+due)\b/i;
const ATTACHMENT_NAME_HINT_REGEX = /\b(statement|stmt|bill|card)\b/i;

const sqsClient = new SQSClient({
  region: getRequiredEnv('AWS_REGION'),
});

const s3Client = new S3Client({
  region: getRequiredEnv('AWS_REGION'),
});

let dataSource: DataSource | null = null;

export const handler = async (event: SqsEvent): Promise<void> => {
  for (const record of event.Records) {
    console.info(
      `[fetch-worker] received record messageId=${record.messageId}`,
    );
    const message = parseMessage(record.body);
    console.info(
      `[fetch-worker] parsed message jobId=${message.jobId} userId=${message.userId} stage=${message.stage}`,
    );

    try {
      await processFetchMessage(message);
      console.info(
        `[fetch-worker] completed message jobId=${message.jobId} userId=${message.userId}`,
      );
    } catch (error) {
      console.error(
        `[fetch-worker] failed message jobId=${message.jobId} userId=${message.userId} error=${formatError(error)}`,
      );
      throw error;
    }
  }
};

const processFetchMessage = async (
  message: FetchQueueMessage,
): Promise<void> => {
  console.info(
    `[fetch-worker] processFetchMessage start jobId=${message.jobId} userId=${message.userId}`,
  );
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

    if (job.stage !== SyncJobStage.FETCH) {
      console.info(
        `[fetch-worker] skipping jobId=${message.jobId} because stage=${job.stage}`,
      );
      return;
    }

    if (
      job.status === SyncJobStatus.SUCCESS ||
      job.status === SyncJobStatus.FAILED
    ) {
      console.info(
        `[fetch-worker] skipping jobId=${message.jobId} because status=${job.status}`,
      );
      return;
    }

    if (job.status === SyncJobStatus.PENDING) {
      job.status = SyncJobStatus.RUNNING;
      job.errorMessage = null;
      await repo.save(job);
      console.info(
        `[fetch-worker] marked RUNNING jobId=${message.jobId} stage=${job.stage}`,
      );
    }
  });

  try {
    console.info(`[fetch-worker] runFetchStep start jobId=${message.jobId}`);
    const emailJobSeeds = await runFetchStep(message.jobId, message.userId);
    console.info(`[fetch-worker] runFetchStep complete jobId=${message.jobId}`);

    await ds.transaction(async (manager) => {
      const repo = manager.getRepository(SyncJobEntity);
      const job = await repo
        .createQueryBuilder('job')
        .setLock('pessimistic_write')
        .where('job.id = :jobId', { jobId: message.jobId })
        .getOne();

      if (!job) {
        throw new Error(
          `SyncJob missing before stage transition. jobId=${message.jobId}`,
        );
      }

      if (job.stage !== SyncJobStage.FETCH) {
        console.info(
          `[fetch-worker] skip stage transition for jobId=${message.jobId} because stage=${job.stage}`,
        );
        return;
      }

      job.stage = SyncJobStage.EXTRACT;
      job.status = SyncJobStatus.RUNNING;
      job.lastProcessedAt = new Date();
      await repo.save(job);
      console.info(
        `[fetch-worker] advanced jobId=${message.jobId} to stage=${job.stage}`,
      );
    });

    console.info(
      `[fetch-worker] creating email jobs jobId=${message.jobId} count=${emailJobSeeds.length}`,
    );
    const emailJobs = await createOrUpdateEmailJobs(
      message.jobId,
      message.userId,
      emailJobSeeds,
    );

    console.info(
      `[fetch-worker] publishing extract messages for email jobs syncJobId=${message.jobId} count=${emailJobs.length}`,
    );
    await Promise.all(
      emailJobs.map((emailJob) =>
        publishExtractStageMessage(emailJob.id, message.userId),
      ),
    );

    console.info(
      `[fetch-worker] published extract messages for email jobs syncJobId=${message.jobId} count=${emailJobs.length}`,
    );
  } catch (error) {
    console.error(
      `[fetch-worker] processFetchMessage error jobId=${message.jobId} userId=${message.userId} error=${formatError(error)}`,
    );
    await markJobFailed(message.jobId, error);
    throw error;
  }
};

const runFetchStep = async (
  jobId: string,
  userId: string,
): Promise<EmailJobSeed[]> => {
  console.info(
    `[fetch-worker] runFetchStep init jobId=${jobId} userId=${userId}`,
  );
  const ds = await getDataSource();
  const jobsRepository = ds.getRepository(SyncJobEntity);
  const oauthRepository = ds.getRepository(OAuthConnectionEntity);

  const job = await jobsRepository.findOne({ where: { id: jobId } });

  if (!job) {
    throw new Error(
      `SyncJob not found while fetching email data. jobId=${jobId}`,
    );
  }

  if (job.userId !== userId) {
    throw new Error(
      `SyncJob user mismatch while fetching email data. jobId=${jobId}`,
    );
  }

  console.info(
    `[fetch-worker] loaded sync job metadata jobId=${jobId} fromDate=${job.fromDate.toISOString()} toDate=${job.toDate.toISOString()}`,
  );

  const googleConnection = await oauthRepository
    .createQueryBuilder('oauthConnection')
    .where('oauthConnection.userId = :userId', { userId })
    .andWhere('oauthConnection.provider = :provider', {
      provider: OAuthProvider.GOOGLE,
    })
    .andWhere('oauthConnection.revokedAt IS NULL')
    .getOne();

  if (!googleConnection?.refreshTokenEncrypted) {
    throw new Error(`Missing active Google refresh token for userId=${userId}`);
  }

  console.info(
    `[fetch-worker] found active google connection for userId=${userId}`,
  );

  const refreshToken = decryptOpaqueToken(
    googleConnection.refreshTokenEncrypted,
  );
  const accessToken = await exchangeRefreshTokenForAccessToken(refreshToken);
  const gmailMessages = await fetchGmailMessages(
    accessToken,
    job.fromDate,
    job.toDate,
  );
  console.info(
    `[fetch-worker] fetched gmail messages count=${gmailMessages.length} jobId=${jobId}`,
  );
  const rawEmailRecords: RawEmailRecord[] = [];
  const emailJobSeeds: EmailJobSeed[] = [];
  let filteredOutCount = 0;
  const rawEmailsKey = buildRawEmailsJsonKey(userId, jobId);

  const limit = pLimit(5);

  const results = await Promise.all(
    gmailMessages.map((gmailMessage) =>
      limit(async () => {
        try {
          const pdfAttachment = await getFirstPdfAttachment(
            accessToken,
            gmailMessage,
          );

          const isStatementCandidate = isLikelyCreditCardStatementEmail(
            gmailMessage,
            pdfAttachment?.filename || null,
          );

          if (!isStatementCandidate) {
            return { filtered: true };
          }

          let s3AttachmentKey: string | null = null;

          if (pdfAttachment) {
            s3AttachmentKey = buildRawAttachmentKey(
              userId,
              jobId,
              gmailMessage.id,
            );

            await uploadBytesToS3(
              s3AttachmentKey,
              pdfAttachment.bytes,
              'application/pdf',
            );
          }

          return {
            filtered: false,
            rawRecord: serializeRawEmailRecord(
              gmailMessage,
              pdfAttachment?.filename || null,
            ),
            seed: {
              emailId: gmailMessage.id,
              s3RawKey: rawEmailsKey,
              s3AttachmentKey,
            },
          };
        } catch (error) {
          console.error(
            `[fetch-worker] email processing failed emailId=${gmailMessage.id} error=${formatError(error)}`,
          );
          return { filtered: true };
        }
      }),
    ),
  );

  for (const res of results) {
    if (res.filtered) {
      filteredOutCount++;
      continue;
    }
    if (!res.rawRecord || !res.seed) {
      continue;
    }

    rawEmailRecords.push(res.rawRecord);
    emailJobSeeds.push(res.seed);
  }

  const rawPayload = {
    userId,
    syncJobId: jobId,
    fromDate: job.fromDate.toISOString(),
    toDate: job.toDate.toISOString(),
    fetchedAt: new Date().toISOString(),
    count: rawEmailRecords.length,
    emails: rawEmailRecords,
  };

  await uploadTextToS3(
    rawEmailsKey,
    JSON.stringify(rawPayload, null, 2),
    'application/json',
  );
  console.info(
    `[fetch-worker] uploaded raw emails payload jobId=${jobId} count=${rawEmailRecords.length}`,
  );
  console.info(
    `[fetch-worker] statement filter summary jobId=${jobId} kept=${rawEmailRecords.length} filteredOut=${filteredOutCount}`,
  );

  return emailJobSeeds;
};

const createOrUpdateEmailJobs = async (
  syncJobId: string,
  userId: string,
  seeds: EmailJobSeed[],
): Promise<EmailJobEntity[]> => {
  const ds = await getDataSource();
  const repo = ds.getRepository(EmailJobEntity);

  if (!seeds.length) return [];

  const existingJobs = await repo.find({
    where: {
      syncJobId,
      emailId: In(seeds.map((s) => s.emailId)),
    },
  });

  // 2. Map for quick lookup
  const existingMap = new Map(existingJobs.map((job) => [job.emailId, job]));

  const toSave: EmailJobEntity[] = [];
  const queueTargets: EmailJobEntity[] = [];

  for (const seed of seeds) {
    const existing = existingMap.get(seed.emailId);

    if (!existing) {
      const newJob = repo.create({
        syncJobId,
        userId,
        emailId: seed.emailId,
        status: EmailJobStatus.PENDING,
        s3RawKey: seed.s3RawKey,
        s3AttachmentKey: seed.s3AttachmentKey,
        errorMessage: null,
      });

      toSave.push(newJob);
      continue;
    }

    if (existing.status === EmailJobStatus.SUCCESS) {
      continue;
    }

    existing.status = EmailJobStatus.PENDING;
    existing.errorMessage = null;
    existing.s3RawKey = seed.s3RawKey;
    existing.s3AttachmentKey = seed.s3AttachmentKey;

    toSave.push(existing);
  }

  if (!toSave.length) return [];

  const savedJobs = await repo.save(toSave);

  for (const job of savedJobs) {
    if (job.status === EmailJobStatus.PENDING) {
      queueTargets.push(job);
    }
  }

  return queueTargets;
};

const fetchGmailMessages = async (
  accessToken: string,
  fromDate: Date,
  toDate: Date,
): Promise<GmailMessage[]> => {
  const references: GmailMessageReference[] = [];
  let nextPageToken: string | undefined;
  const query = buildGmailDateRangeQuery(fromDate, toDate);

  do {
    const listResponse = await gmailApiRequest<GmailListResponse>(
      '/gmail/v1/users/me/messages',
      accessToken,
      {
        q: query,
        maxResults: '100',
        pageToken: nextPageToken,
      },
    );

    references.push(...(listResponse.messages || []));
    nextPageToken = listResponse.nextPageToken;
  } while (nextPageToken);

  const uniqueReferences = dedupeMessageReferences(references);

  const limit = pLimit(5);

  const messages = await Promise.all(
    uniqueReferences.map((reference) =>
      limit(() =>
        gmailApiRequest<GmailMessage>(
          `/gmail/v1/users/me/messages/${encodeURIComponent(reference.id)}`,
          accessToken,
          { format: 'full' },
        ),
      ),
    ),
  );

  return messages;
};

const exchangeRefreshTokenForAccessToken = async (
  refreshToken: string,
): Promise<string> => {
  const oauthClient = new OAuth2Client({
    clientId: getRequiredEnv('GOOGLE_CLIENT_ID'),
    clientSecret: getRequiredEnv('GOOGLE_CLIENT_SECRET'),
    redirectUri: getRequiredEnv('GOOGLE_REDIRECT_URI'),
  });

  oauthClient.setCredentials({ refresh_token: refreshToken });
  const accessToken = await oauthClient.getAccessToken();

  if (!accessToken.token) {
    throw new Error('Google did not return an access token for fetch worker.');
  }

  return accessToken.token;
};

const gmailApiRequest = async <T>(
  path: string,
  accessToken: string,
  query: Record<string, string | undefined> = {},
): Promise<T> => {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value) {
      params.set(key, value);
    }
  }

  const url = `https://gmail.googleapis.com${path}${params.size > 0 ? `?${params.toString()}` : ''}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Gmail API request failed (${response.status}): ${body.slice(0, 1000)}`,
    );
  }

  return (await response.json()) as T;
};

const getFirstPdfAttachment = async (
  accessToken: string,
  message: GmailMessage,
): Promise<{ filename: string; bytes: Uint8Array } | null> => {
  const payload = message.payload;

  if (!payload) {
    return null;
  }

  const pdfPart = findFirstPdfPart(payload);

  if (!pdfPart) {
    return null;
  }

  const messageId = encodeURIComponent(message.id);
  const attachmentId = pdfPart.body?.attachmentId;

  if (attachmentId) {
    const attachmentResponse = await gmailApiRequest<GmailAttachmentResponse>(
      `/gmail/v1/users/me/messages/${messageId}/attachments/${encodeURIComponent(attachmentId)}`,
      accessToken,
    );

    if (!attachmentResponse.data) {
      return null;
    }

    return {
      filename: normalizePdfFilename(pdfPart.filename),
      bytes: decodeBase64Url(attachmentResponse.data),
    };
  }

  if (!pdfPart.body?.data) {
    return null;
  }

  return {
    filename: normalizePdfFilename(pdfPart.filename),
    bytes: decodeBase64Url(pdfPart.body.data),
  };
};

const serializeRawEmailRecord = (
  message: GmailMessage,
  pdfAttachmentFilename: string | null,
): RawEmailRecord => {
  const headers = getMessageHeaders(message.payload);
  const content = extractEmailContent(message.payload);

  return {
    id: message.id,
    threadId: message.threadId,
    snippet: message.snippet || '',
    internalDate: message.internalDate
      ? new Date(Number(message.internalDate)).toISOString()
      : null,
    labels: message.labelIds || [],
    from: headers.from || null,
    to: headers.to || null,
    subject: headers.subject || null,
    bodyText: content.text,
    bodyHtml: content.html,
    hasPdfAttachment: Boolean(pdfAttachmentFilename),
    pdfAttachmentFilename,
  };
};

const getMessageHeaders = (payload?: GmailMessagePart) => {
  const result: { from?: string; to?: string; subject?: string } = {};
  const headers = payload?.headers || [];

  for (const header of headers) {
    const name = header.name?.toLowerCase();
    const value = header.value?.trim();

    if (!name || !value) {
      continue;
    }

    if (name === 'from') {
      result.from = value;
    }

    if (name === 'to') {
      result.to = value;
    }

    if (name === 'subject') {
      result.subject = value;
    }
  }

  return result;
};

const findFirstPdfPart = (part: GmailMessagePart): GmailMessagePart | null => {
  const mimeType = (part.mimeType || '').toLowerCase();
  const filename = (part.filename || '').toLowerCase();

  if (mimeType === 'application/pdf' || filename.endsWith('.pdf')) {
    return part;
  }

  for (const child of part.parts || []) {
    const found = findFirstPdfPart(child);

    if (found) {
      return found;
    }
  }

  return null;
};

const buildGmailDateRangeQuery = (fromDate: Date, toDate: Date): string => {
  const after = Math.floor(fromDate.getTime() / 1000);
  const before = Math.floor(toDate.getTime() / 1000);
  return `in:inbox has:attachment filename:pdf (subject:(statement OR bill OR "e-statement" OR estatement) OR "credit card statement" OR "card statement" OR "minimum due" OR "total due" OR "payment due") after:${after} before:${before}`;
};

const extractEmailContent = (
  payload?: GmailMessagePart,
): { text: string | null; html: string | null } => {
  if (!payload) {
    return { text: null, html: null };
  }

  const textParts: string[] = [];
  const htmlParts: string[] = [];

  const walk = (part: GmailMessagePart) => {
    const mimeType = (part.mimeType || '').toLowerCase();
    const data = part.body?.data;

    if (data) {
      const decoded = decodeBase64UrlToUtf8(data);

      if (mimeType === 'text/plain') {
        textParts.push(decoded);
      }

      if (mimeType === 'text/html') {
        htmlParts.push(decoded);
      }
    }

    for (const child of part.parts || []) {
      walk(child);
    }
  };

  walk(payload);

  return {
    text: textParts.length > 0 ? textParts.join('\n') : null,
    html: htmlParts.length > 0 ? htmlParts.join('\n') : null,
  };
};

const isLikelyCreditCardStatementEmail = (
  message: GmailMessage,
  pdfAttachmentFilename: string | null,
): boolean => {
  const headers = getMessageHeaders(message.payload);
  const searchableText = [
    headers.subject || '',
    headers.from || '',
    message.snippet || '',
    pdfAttachmentFilename || '',
  ].join(' ');

  const hasCardKeyword = CARD_KEYWORD_REGEX.test(searchableText);
  const hasStatementKeyword = STATEMENT_KEYWORD_REGEX.test(searchableText);
  const hasAttachmentHint =
    Boolean(pdfAttachmentFilename) &&
    ATTACHMENT_NAME_HINT_REGEX.test(pdfAttachmentFilename || '');

  return (hasCardKeyword && hasStatementKeyword) || hasAttachmentHint;
};

const dedupeMessageReferences = (
  references: GmailMessageReference[],
): GmailMessageReference[] => {
  const seen = new Set<string>();
  const deduped: GmailMessageReference[] = [];

  for (const reference of references) {
    if (seen.has(reference.id)) {
      continue;
    }

    seen.add(reference.id);
    deduped.push(reference);
  }

  return deduped;
};

const buildRawEmailsJsonKey = (userId: string, jobId: string): string => {
  return `user_${userId}/sync_${jobId}/emails.json`;
};

const buildRawAttachmentKey = (
  userId: string,
  jobId: string,
  emailId: string,
): string => {
  return `user_${userId}/sync_${jobId}/attachments/email_${emailId}.pdf`;
};

const getRawBucketName = (): string => {
  return getRequiredEnv('SYNC_RAW_BUCKET_NAME');
};

const uploadTextToS3 = async (
  key: string,
  content: string,
  contentType: string,
): Promise<void> => {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: getRawBucketName(),
      Key: key,
      Body: Buffer.from(content, 'utf8'),
      ContentType: contentType,
    }),
  );
};

const uploadBytesToS3 = async (
  key: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> => {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: getRawBucketName(),
      Key: key,
      Body: Buffer.from(bytes),
      ContentType: contentType,
    }),
  );
};

const decryptOpaqueToken = (encryptedToken: string): string => {
  const segments = encryptedToken.split('.');

  if (segments.length !== 3) {
    throw new Error('Invalid encrypted OAuth token format.');
  }

  const rawKey = getRequiredEnv('OAUTH_TOKEN_ENCRYPTION_KEY');
  const key = createHash('sha256').update(rawKey).digest();
  const [ivEncoded, tagEncoded, bodyEncoded] = segments as [
    string,
    string,
    string,
  ];
  const iv = Buffer.from(ivEncoded, 'base64url');
  const tag = Buffer.from(tagEncoded, 'base64url');
  const encryptedBody = Buffer.from(bodyEncoded, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);

  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(encryptedBody),
    decipher.final(),
  ]).toString('utf8');
};

const normalizePdfFilename = (filename?: string): string => {
  const trimmed = (filename || '').trim();

  if (!trimmed) {
    return 'attachment.pdf';
  }

  return trimmed.toLowerCase().endsWith('.pdf') ? trimmed : `${trimmed}.pdf`;
};

const decodeBase64Url = (value: string): Uint8Array => {
  return Buffer.from(value, 'base64url');
};

const decodeBase64UrlToUtf8 = (value: string): string => {
  return Buffer.from(value, 'base64url').toString('utf8');
};

const publishExtractStageMessage = async (
  emailJobId: string,
  userId: string,
): Promise<void> => {
  const queueUrl = getRequiredEnv('SYNC_EXTRACT_QUEUE_URL');

  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({
        jobId: emailJobId,
        userId,
        stage: SyncJobStage.EXTRACT,
      }),
    }),
  );
  console.info(
    `[fetch-worker] sent extract queue message emailJobId=${emailJobId} userId=${userId}`,
  );
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
  console.error(
    `[fetch-worker] marked job FAILED jobId=${jobId} error=${job.errorMessage}`,
  );
};

const parseMessage = (rawBody: string): FetchQueueMessage => {
  const parsed = JSON.parse(rawBody) as Partial<FetchQueueMessage>;

  if (!parsed.jobId || !parsed.userId || !parsed.stage) {
    throw new Error('Invalid fetch queue message payload.');
  }

  if (parsed.stage !== SyncJobStage.FETCH) {
    throw new Error(`Fetch worker received unsupported stage=${parsed.stage}`);
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
  const dbRejectUnauthorized = parseBooleanEnv(
    'DB_SSL_REJECT_UNAUTHORIZED',
    true,
  );

  dataSource = new DataSource({
    type: 'postgres',
    url: getRequiredEnv('DATABASE_URL'),
    entities: [
      SyncJobEntity,
      EmailJobEntity,
      OAuthConnectionEntity,
      UserEntity,
    ],
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

  return 'Unknown fetch worker error.';
};
