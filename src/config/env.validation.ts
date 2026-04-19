const REQUIRED_ENV_KEYS = [
  'DATABASE_URL',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
  'OAUTH_TOKEN_ENCRYPTION_KEY',
  'JWT_SECRET',
  'ACCESS_TOKEN_SECRET',
  'REFRESH_TOKEN_PEPPER',
  'AWS_REGION',
  'SYNC_FETCH_QUEUE_URL',
  'SYNC_EXTRACT_QUEUE_URL',
  'SYNC_PROCESS_QUEUE_URL',
] as const;

const hasAwsCredentialProvider = (env: Record<string, unknown>) => {
  const accessKeyId = String(env.AWS_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = String(env.AWS_SECRET_ACCESS_KEY || '').trim();

  if (accessKeyId && secretAccessKey) {
    return true;
  }

  const awsProfile = String(env.AWS_PROFILE || '').trim();

  if (awsProfile) {
    return true;
  }

  const webIdentityTokenFile = String(env.AWS_WEB_IDENTITY_TOKEN_FILE || '').trim();
  const roleArn = String(env.AWS_ROLE_ARN || '').trim();

  if (webIdentityTokenFile && roleArn) {
    return true;
  }

  const ecsRelativeUri = String(env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || '').trim();
  const ecsFullUri = String(env.AWS_CONTAINER_CREDENTIALS_FULL_URI || '').trim();

  return Boolean(ecsRelativeUri || ecsFullUri);
};

export const validateEnv = (rawEnv: Record<string, unknown>) => {
  const missingKeys: string[] = REQUIRED_ENV_KEYS.filter(
    (key) => !String(rawEnv[key] || '').trim(),
  );

  if (!hasAwsCredentialProvider(rawEnv)) {
    missingKeys.push(
      'AWS credentials provider (set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or AWS_PROFILE or role-based provider envs)',
    );
  }

  if (missingKeys.length > 0) {
    throw new Error(`Missing required environment configuration: ${missingKeys.join(', ')}`);
  }

  return rawEnv;
};
