import crypto from "node:crypto";

import express from "express";
import Redis from "ioredis";
import pg from "pg";
import client from "prom-client";

import { ensureSchema } from "./schema.js";

const { Pool } = pg;

const port = Number(process.env.PORT ?? 3000);
const cacheTtlSeconds = Number(process.env.CACHE_TTL_SECONDS ?? 5);
const rateLimitPerSecond = Number(process.env.RATE_LIMIT_PER_SECOND ?? 500);
const maxQueueDepth = Number(process.env.MAX_QUEUE_DEPTH ?? 2000);
const orderQueueName = process.env.ORDER_QUEUE_NAME ?? "orders:pending";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_SIZE ?? 12),
  idleTimeoutMillis: 10_000
});

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: 2
});

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "64kb" }));

client.collectDefaultMetrics({
  labels: { service: "api" }
});

const httpDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request latency by route and status.",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5]
});

const dbDuration = new client.Histogram({
  name: "db_query_duration_seconds",
  help: "Database query latency by operation.",
  labelNames: ["operation"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2]
});

const cacheEvents = new client.Counter({
  name: "cache_events_total",
  help: "Redis cache events.",
  labelNames: ["result"]
});

const ordersEnqueued = new client.Counter({
  name: "orders_enqueued_total",
  help: "Orders accepted by the API and placed onto the Redis queue.",
  labelNames: ["status", "reason"]
});

const syncOrdersTotal = new client.Counter({
  name: "sync_orders_total",
  help: "Orders processed synchronously by the API comparison endpoint.",
  labelNames: ["status", "reason"]
});

const rateLimitedTotal = new client.Counter({
  name: "rate_limited_requests_total",
  help: "Requests rejected by the simple Redis-backed rate limiter."
});

const queueDepthGauge = new client.Gauge({
  name: "order_queue_depth",
  help: "Current Redis order queue depth.",
  labelNames: ["queue"]
});

const inventoryGauge = new client.Gauge({
  name: "inventory_remaining",
  help: "Current product inventory remaining.",
  labelNames: ["product_id", "product_name"]
});

const asyncHandler = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

app.use((req, res, next) => {
  const end = httpDuration.startTimer();
  res.on("finish", () => {
    end({
      method: req.method,
      route: req.route?.path ?? req.path,
      status_code: String(res.statusCode)
    });
  });
  next();
});

async function query(operation, text, params = []) {
  const end = dbDuration.startTimer({ operation });
  try {
    return await pool.query(text, params);
  } finally {
    end();
  }
}

async function setQueueDepthMetric() {
  const depth = await redis.llen(orderQueueName);
  queueDepthGauge.set({ queue: orderQueueName }, depth);
  return depth;
}

async function refreshInventoryMetrics() {
  const result = await query(
    "inventory_metrics",
    "SELECT id, name, stock FROM products ORDER BY id"
  );
  inventoryGauge.reset();
  for (const row of result.rows) {
    inventoryGauge.set(
      { product_id: String(row.id), product_name: row.name },
      row.stock
    );
  }
}

async function enforceRateLimit(req, res, next) {
  try {
    const key = `rate:${req.ip}`;
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, 1);
    }
    if (count > rateLimitPerSecond) {
      rateLimitedTotal.inc();
      return res.status(429).json({ error: "rate_limited" });
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

function parseProductId(req) {
  const productId = Number(req.body.productId ?? 1);
  if (!Number.isInteger(productId) || productId < 1) {
    return null;
  }
  return productId;
}

async function findExistingOrder(idempotencyKey) {
  if (!idempotencyKey) {
    return null;
  }

  const existing = await query(
    "find_idempotent_order",
    `SELECT id, product_id, status, failure_reason, attempts, created_at, updated_at
     FROM orders
     WHERE idempotency_key = $1`,
    [idempotencyKey]
  );

  return existing.rows[0] ?? null;
}

app.get("/health", asyncHandler(async (_req, res) => {
  await query("health", "SELECT 1");
  await redis.ping();
  res.json({ ok: true });
}));

app.get("/products", asyncHandler(async (_req, res) => {
  const cacheKey = "products:v1";
  const cached = await redis.get(cacheKey);
  if (cached) {
    cacheEvents.inc({ result: "hit" });
    const body = JSON.parse(cached);
    return res.json({ ...body, cached: true });
  }

  cacheEvents.inc({ result: "miss" });
  const result = await query(
    "list_products",
    "SELECT id, name, price_cents, stock FROM products ORDER BY id"
  );
  const body = { products: result.rows, cached: false };
  await redis.set(cacheKey, JSON.stringify(body), "EX", cacheTtlSeconds);
  return res.json(body);
}));

app.post("/orders", enforceRateLimit, asyncHandler(async (req, res) => {
  const productId = parseProductId(req);
  const idempotencyKey = req.get("Idempotency-Key") ?? req.body.idempotencyKey ?? null;

  if (!productId) {
    ordersEnqueued.inc({ status: "rejected", reason: "bad_request" });
    return res.status(400).json({ error: "invalid_product_id" });
  }

  const currentQueueDepth = await setQueueDepthMetric();
  if (currentQueueDepth >= maxQueueDepth) {
    ordersEnqueued.inc({ status: "rejected", reason: "queue_full" });
    return res.status(503).json({
      error: "queue_full",
      queueDepth: currentQueueDepth,
      message: "Order intake is temporarily throttled because workers are saturated."
    });
  }

  const existing = await findExistingOrder(idempotencyKey);
  if (existing) {
    const statusCode = ["pending", "processing", "retrying"].includes(existing.status) ? 202 : 200;
    return res.status(statusCode).json({ order: existing, replayed: true });
  }

  let insert;
  try {
    insert = await query(
      "create_pending_order",
      `INSERT INTO orders (product_id, idempotency_key, status)
       VALUES ($1, $2, 'pending')
       RETURNING id, product_id, status, failure_reason, attempts, created_at, updated_at`,
      [productId, idempotencyKey]
    );
  } catch (error) {
    if (error.code === "23505" && idempotencyKey) {
      const existingAfterRace = await findExistingOrder(idempotencyKey);
      return res.status(202).json({ order: existingAfterRace, replayed: true });
    }
    throw error;
  }

  const order = insert.rows[0];
  await redis.rpush(orderQueueName, String(order.id));
  const queueDepth = await setQueueDepthMetric();

  ordersEnqueued.inc({ status: "queued", reason: "none" });
  return res.status(202).json({
    order,
    queueDepth,
    statusUrl: `/orders/${order.id}`,
    requestId: crypto.randomUUID()
  });
}));

app.get("/orders/:id", asyncHandler(async (req, res) => {
  const orderId = Number(req.params.id);
  if (!Number.isInteger(orderId) || orderId < 1) {
    return res.status(400).json({ error: "invalid_order_id" });
  }

  const result = await query(
    "get_order",
    `SELECT o.id, o.product_id, p.name AS product_name, o.status, o.failure_reason,
            o.attempts, o.created_at, o.updated_at
     FROM orders o
     JOIN products p ON p.id = o.product_id
     WHERE o.id = $1`,
    [orderId]
  );

  if (result.rowCount === 0) {
    return res.status(404).json({ error: "order_not_found" });
  }

  return res.json({ order: result.rows[0] });
}));

app.post("/orders-sync", enforceRateLimit, asyncHandler(async (req, res) => {
  const productId = parseProductId(req);
  const idempotencyKey = req.get("Idempotency-Key") ?? req.body.idempotencyKey ?? null;

  if (!productId) {
    syncOrdersTotal.inc({ status: "rejected", reason: "bad_request" });
    return res.status(400).json({ error: "invalid_product_id" });
  }

  const existing = await findExistingOrder(idempotencyKey);
  if (existing) {
    return res.status(200).json({ order: existing, replayed: true });
  }

  const db = await pool.connect();
  const end = dbDuration.startTimer({ operation: "sync_order_transaction" });
  try {
    await db.query("BEGIN");

    const updated = await db.query(
      `UPDATE products
       SET stock = stock - 1, updated_at = now()
       WHERE id = $1 AND stock > 0
       RETURNING id, name, stock`,
      [productId]
    );

    if (updated.rowCount === 0) {
      const rejected = await db.query(
        `INSERT INTO orders (product_id, idempotency_key, status, failure_reason)
         VALUES ($1, $2, 'rejected', 'sold_out')
         RETURNING id, product_id, status, failure_reason, attempts, created_at, updated_at`,
        [productId, idempotencyKey]
      );
      await db.query("COMMIT");
      syncOrdersTotal.inc({ status: "rejected", reason: "sold_out" });
      return res.status(409).json({ order: rejected.rows[0] });
    }

    const order = await db.query(
      `INSERT INTO orders (product_id, idempotency_key, status)
       VALUES ($1, $2, 'accepted')
       RETURNING id, product_id, status, failure_reason, attempts, created_at, updated_at`,
      [productId, idempotencyKey]
    );

    await db.query("COMMIT");
    await redis.del("products:v1");
    syncOrdersTotal.inc({ status: "accepted", reason: "none" });
    inventoryGauge.set(
      { product_id: String(updated.rows[0].id), product_name: updated.rows[0].name },
      updated.rows[0].stock
    );
    return res.status(201).json({ order: order.rows[0], remainingStock: updated.rows[0].stock });
  } catch (error) {
    try {
      await db.query("ROLLBACK");
    } catch (rollbackError) {
      console.error({ rollbackError: rollbackError.message });
    }
    if (error.code === "23505") {
      const existingAfterRace = await findExistingOrder(idempotencyKey);
      return res.status(200).json({ order: existingAfterRace, replayed: true });
    }
    throw error;
  } finally {
    end();
    db.release();
  }
}));

app.get("/metrics", asyncHandler(async (_req, res) => {
  await Promise.all([refreshInventoryMetrics(), setQueueDepthMetric()]);
  res.set("Content-Type", client.register.contentType);
  res.end(await client.register.metrics());
}));

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "internal_error" });
});

let server;

async function start() {
  await ensureSchema(pool);
  server = app.listen(port, () => {
    console.log(`flash sale api listening on :${port}`);
  });
}

async function shutdown() {
  if (server) {
    server.close();
  }
  await redis.quit();
  await pool.end();
}

process.on("SIGTERM", () => {
  shutdown().finally(() => process.exit(0));
});

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
