# Credix NestJS

NestJS backend with Google auth, sync workers, and TypeORM.

## Setup

```bash
pnpm install
```

## Run

```bash
# dev
pnpm run start:dev

# prod (after build)
pnpm run build
pnpm run start:prod
```

## Code Quality

```bash
# format files
pnpm run format

# verify formatting
pnpm run format:check

# lint
pnpm run lint

# lint with autofix
pnpm run lint:fix

# strict TypeScript check
pnpm run typecheck
```

## Tests

```bash
pnpm run test
pnpm run test:e2e
pnpm run test:cov
```

## Git Hooks and Commit Rules

This repo is configured with Husky + lint-staged + commitlint.

- `pre-commit`: runs `lint-staged` (Prettier + ESLint fixes on staged files)
- `pre-push`: runs `typecheck` and `test`
- `commit-msg`: enforces Conventional Commits via commitlint

Examples:

```text
feat(auth): add refresh token rotation
fix(sync): handle missing queue URL
chore(ci): update pnpm cache key
```

## CI

GitHub Actions workflow is defined in `.github/workflows/ci.yml`.

It runs on push to `master` and all pull requests:

- install dependencies
- format check
- lint
- typecheck
- tests
- build

## Docker

### Build and run with Docker

```bash
docker build -t credix-nestjs .
docker run --env-file .env.local -p 3000:3000 credix-nestjs
```

### Run with Docker Compose

```bash
docker compose up --build
```

## Notes

- Ensure `.env.local` exists before running the app in Docker Compose.
- The Docker image uses a multi-stage build for smaller production images.
