const esbuild = require('esbuild');

esbuild
  .build({
    entryPoints: ['src/workers/fetch/handler.ts'],
    bundle: true,
    platform: 'node',
    target: 'node18',
    outfile: 'lambda-dist/fetch-handler.js',
  })
  .catch(() => process.exit(1));

esbuild
  .build({
    entryPoints: ['src/workers/extract/handler.ts'],
    bundle: true,
    platform: 'node',
    target: 'node18',
    outfile: 'lambda-dist/extract-handler.js',
  })
  .catch(() => process.exit(1));

esbuild
  .build({
    entryPoints: ['src/workers/process/handler.ts'],
    bundle: true,
    platform: 'node',
    target: 'node18',
    outfile: 'lambda-dist/process-handler.js',
  })
  .catch(() => process.exit(1));
