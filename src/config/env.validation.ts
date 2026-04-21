const REQUIRED_ENV_KEYS = [
  'NODE_ENV',
  'PORT',
  'DATABASE_URL',
  'DB_SSL',
  'DB_SSL_REJECT_UNAUTHORIZED',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
  'GOOGLE_OAUTH_SCOPES',
  'OAUTH_TOKEN_ENCRYPTION_KEY',
  'JWT_SECRET',
  'JWT_EXPIRES_IN_SECONDS',
  'ACCESS_TOKEN_SECRET',
  'ACCESS_TOKEN_EXPIRES_IN_SECONDS',
  'REFRESH_TOKEN_EXPIRES_IN_SECONDS',
  'REFRESH_TOKEN_PEPPER',
  'AWS_REGION',
  'SYNC_FETCH_QUEUE_URL',
  'SYNC_EXTRACT_QUEUE_URL',
  'SYNC_PROCESS_QUEUE_URL',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
] as const;

export const validateEnv = (rawEnv: Record<string, unknown>) => {
  const missingKeys: string[] = REQUIRED_ENV_KEYS.filter(
    (key) => !String(rawEnv[key] || '').trim(),
  );

  if (missingKeys.length > 0) {
    throw new Error(
      `Missing required environment configuration: ${missingKeys.join(', ')}`,
    );
  }

  return rawEnv;
};
