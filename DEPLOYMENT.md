# Deployment Notes

## Local Production-Like Run

```bash
docker compose up --build
```

Services:

- API and Nginx gateway on `http://localhost:3000`
- Grafana on `http://localhost:3100`
- Prometheus on `http://localhost:9090`
- Postgres and Redis as backing services

Scale locally:

```bash
docker compose up --build --scale api=3 --scale worker=3
```

## Railway Cloud Deployment

The app is cloud-ready for Railway:

- `railway.json` tells Railway to build from the Dockerfile.
- The Dockerfile can run either API or worker based on `SERVICE_ROLE`.
- The app runs idempotent startup schema creation, so managed Postgres starts empty safely.

Expected Railway services:

1. `api`
2. `worker`
3. managed `Postgres`
4. managed `Redis`

API service variables:

```text
SERVICE_ROLE=api
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
DB_POOL_SIZE=12
CACHE_TTL_SECONDS=5
MAX_QUEUE_DEPTH=2000
RATE_LIMIT_PER_SECOND=500
ORDER_QUEUE_NAME=orders:pending
```

Worker service variables:

```text
SERVICE_ROLE=worker
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
WORKER_DB_POOL_SIZE=8
WORKER_MAX_ATTEMPTS=3
ORDER_QUEUE_NAME=orders:pending
```

CLI flow after Railway billing/account setup:

```bash
railway init -n flash-sale-observability-demo
railway add --database postgres
railway add --database redis
railway add --service api
railway add --service worker
railway variables --service api --set 'SERVICE_ROLE=api' --set 'DATABASE_URL=${{Postgres.DATABASE_URL}}' --set 'REDIS_URL=${{Redis.REDIS_URL}}' --set 'MAX_QUEUE_DEPTH=2000'
railway variables --service worker --set 'SERVICE_ROLE=worker' --set 'DATABASE_URL=${{Postgres.DATABASE_URL}}' --set 'REDIS_URL=${{Redis.REDIS_URL}}'
railway up --service api
railway up --service worker
railway domain --service api --port 3000
```

Status as of this run: Railway CLI authentication succeeded, but project creation was blocked because the Railway trial had expired and the account must select a paid plan before new resources can be provisioned.
