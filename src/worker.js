import express from "express";
import Redis from "ioredis";
import pg from "pg";
import client from "prom-client";

import { ensureSchema } from "./schema.js";

const { Pool } = pg;

const metricsPort = Number(process.env.WORKER_METRICS_PORT ?? process.env.PORT ?? 3001);
const orderQueueName = process.env.ORDER_QUEUE_NAME ?? "orders:pending";
const maxAttempts = Number(process.env.WORKER_MAX_ATTEMPTS ?? 3);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.WORKER_DB_POOL_SIZE ?? 8),
  idleTimeoutMillis: 10_000
});

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: 2
});

client.collectDefaultMetrics({
  labels: { service: "worker" }
});

const dbDuration = new client.Histogram({
  name: "db_query_duration_seconds",
  help: "Database query latency by operation.",
  labelNames: ["operation"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2]
});

const orderProcessingDuration = new client.Histogram({
  name: "order_processing_duration_seconds",
  help: "End-to-end worker processing latency for an order.",
  labelNames: ["outcome"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5]
});

const ordersTotal = new client.Counter({
  name: "orders_total",
  help: "Final order outcomes from the async worker.",
  labelNames: ["status", "reason"]
});

const workerJobsTotal = new client.Counter({
  name: "worker_jobs_total",
  help: "Worker job attempts by outcome.",
  labelNames: ["outcome"]
});

const queueDepthGauge = new client.Gauge({
  name: "order_queue_depth",
  help: "Current Redis order queue depth.",
  labelNames: ["queue"]
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

async function claimOrder(orderId) {
  const result = await query(
    "claim_order",
    `UPDATE orders
     SET status = 'processing', attempts = attempts + 1, updated_at = now()
     WHERE id = $1 AND status IN ('pending', 'retrying')
     RETURNING id, product_id, attempts`,
    [orderId]
  );

  return result.rows[0] ?? null;
}

async function markOrderForRetry(orderId, attempts, error) {
  const finalAttempt = attempts >= maxAttempts;
  await query(
    "mark_order_retry_or_failed",
    `UPDATE orders
     SET status = $2,
         failure_reason = $3,
         updated_at = now()
     WHERE id = $1`,
    [
      orderId,
      finalAttempt ? "failed" : "retrying",
      finalAttempt ? "worker_failed" : "worker_retry"
    ]
  );

  if (!finalAttempt) {
    await redis.rpush(orderQueueName, String(orderId));
  }

  console.error({ orderId, attempts, error: error.message });
  workerJobsTotal.inc({ outcome: finalAttempt ? "failed" : "retrying" });
}

async function processOrder(orderId) {
  const claimed = await claimOrder(orderId);
  if (!claimed) {
    workerJobsTotal.inc({ outcome: "skipped" });
    return;
  }

  const endProcessing = orderProcessingDuration.startTimer();
  const db = await pool.connect();
  const endDb = dbDuration.startTimer({ operation: "process_order_transaction" });
  try {
    await db.query("BEGIN");

    const updated = await db.query(
      `UPDATE products
       SET stock = stock - 1, updated_at = now()
       WHERE id = $1 AND stock > 0
       RETURNING id, stock`,
      [claimed.product_id]
    );

    if (updated.rowCount === 0) {
      await db.query(
        `UPDATE orders
         SET status = 'rejected',
             failure_reason = 'sold_out',
             updated_at = now()
         WHERE id = $1`,
        [claimed.id]
      );
      await db.query("COMMIT");
      ordersTotal.inc({ status: "rejected", reason: "sold_out" });
      workerJobsTotal.inc({ outcome: "rejected" });
      endProcessing({ outcome: "rejected" });
      return;
    }

    await db.query(
      `UPDATE orders
       SET status = 'accepted',
           failure_reason = NULL,
           updated_at = now()
       WHERE id = $1`,
      [claimed.id]
    );
    await db.query("COMMIT");
    await redis.del("products:v1");
    ordersTotal.inc({ status: "accepted", reason: "none" });
    workerJobsTotal.inc({ outcome: "accepted" });
    endProcessing({ outcome: "accepted" });
  } catch (error) {
    try {
      await db.query("ROLLBACK");
    } catch (rollbackError) {
      console.error({ orderId: claimed.id, rollbackError: rollbackError.message });
    }
    endProcessing({ outcome: "error" });
    await markOrderForRetry(claimed.id, claimed.attempts, error);
  } finally {
    endDb();
    db.release();
  }
}

const app = express();

app.get("/health", async (_req, res, next) => {
  try {
    await query("worker_health", "SELECT 1");
    await redis.ping();
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/metrics", async (_req, res, next) => {
  try {
    await setQueueDepthMetric();
    res.set("Content-Type", client.register.contentType);
    res.end(await client.register.metrics());
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "internal_error" });
});

let server;

let running = true;

async function workLoop() {
  console.log(`worker consuming Redis queue ${orderQueueName}`);
  while (running) {
    const item = await redis.blpop(orderQueueName, 5);
    if (!item) {
      await setQueueDepthMetric();
      continue;
    }

    await setQueueDepthMetric();
    await processOrder(Number(item[1]));
  }
}

async function shutdown() {
  running = false;
  if (server) {
    server.close();
  }
  await redis.quit();
  await pool.end();
}

process.on("SIGTERM", () => {
  shutdown().finally(() => process.exit(0));
});

async function start() {
  await ensureSchema(pool);
  server = app.listen(metricsPort, () => {
    console.log(`flash sale worker metrics listening on :${metricsPort}`);
  });
  await workLoop();
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
