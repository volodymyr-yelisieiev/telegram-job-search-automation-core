# Local Smoke Commands

```bash
pnpm install
docker compose up -d postgres redis
pnpm db:migrate
pnpm verify
STATE_BACKEND=postgres API_PORT=3127 API_TOKEN=local-dev-token pnpm smoke:local
```

`pnpm smoke:local` defaults to `STATE_BACKEND=postgres`, starts the API, checks `/health`, verifies unauthenticated routes fail, exercises authenticated API routes with bearer and `X-API-Token`, runs worker smokes, and then stops the API process.
