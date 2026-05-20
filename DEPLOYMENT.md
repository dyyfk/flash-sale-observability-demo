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

The app is deployed on Railway:

- API: `https://api-production-80a1.up.railway.app`
- Project: `flash-sale-observability-demo`
- Services: `api`, `worker`, `postgres`, `redis`

The app is cloud-ready for Railway:

- `railway.json` tells Railway to build from the Dockerfile.
- The Dockerfile can run either API or worker based on `SERVICE_ROLE`.
- The app runs idempotent startup schema creation, so Postgres starts empty safely.

Railway services:

1. `api`
2. `worker`
3. `postgres`
4. `redis`

API service variables:

```text
SERVICE_ROLE=api
DATABASE_URL=postgres://postgres:postgres@postgres.railway.internal:5432/flash_sale
REDIS_URL=redis://redis.railway.internal:6379
DB_POOL_SIZE=12
CACHE_TTL_SECONDS=5
MAX_QUEUE_DEPTH=2000
RATE_LIMIT_PER_SECOND=500
ORDER_QUEUE_NAME=orders:pending
```

Worker service variables:

```text
SERVICE_ROLE=worker
DATABASE_URL=postgres://postgres:postgres@postgres.railway.internal:5432/flash_sale
REDIS_URL=redis://redis.railway.internal:6379
WORKER_DB_POOL_SIZE=8
WORKER_MAX_ATTEMPTS=3
WORKER_PROCESSING_DELAY_MS=750
ORDER_QUEUE_NAME=orders:pending
```

CLI flow after Railway billing/account setup:

```bash
railway init -n flash-sale-observability-demo
railway add --image postgres:16-alpine --service postgres --variables POSTGRES_USER=postgres --variables POSTGRES_PASSWORD=postgres --variables POSTGRES_DB=flash_sale
railway add --image redis:7-alpine --service redis
railway add --service api
railway add --service worker
railway variable set --service api SERVICE_ROLE=api 'DATABASE_URL=postgres://postgres:postgres@postgres.railway.internal:5432/flash_sale' 'REDIS_URL=redis://redis.railway.internal:6379' MAX_QUEUE_DEPTH=2000
railway variable set --service worker SERVICE_ROLE=worker 'DATABASE_URL=postgres://postgres:postgres@postgres.railway.internal:5432/flash_sale' 'REDIS_URL=redis://redis.railway.internal:6379'
railway up --service api
railway up --service worker
railway domain --service api --port 3000
```

Status as of this run: Railway managed database templates returned `Unauthorized`, so Postgres and Redis were deployed as official Docker image services instead. API smoke tests passed for `/health`, `/products`, `/metrics`, and async `/orders` processing.
