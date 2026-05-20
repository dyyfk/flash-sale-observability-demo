import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const baseUrl = process.env.AUTOSCALE_BASE_URL ?? "http://localhost:3000";
const minWorkers = Number(process.env.AUTOSCALE_MIN_WORKERS ?? 1);
const maxWorkers = Number(process.env.AUTOSCALE_MAX_WORKERS ?? 5);
const queuePerWorkerTarget = Number(process.env.AUTOSCALE_QUEUE_PER_WORKER_TARGET ?? 10);
const scaleDownQueueDepth = Number(process.env.AUTOSCALE_SCALE_DOWN_QUEUE_DEPTH ?? 2);
const pollMs = Number(process.env.AUTOSCALE_POLL_MS ?? 2000);
const cooldownMs = Number(process.env.AUTOSCALE_COOLDOWN_MS ?? 6000);
const durationMs = Number(process.env.AUTOSCALE_DURATION_MS ?? 90000);
const dryRun = process.env.AUTOSCALE_DRY_RUN === "1";

let lastScaleAt = 0;
let lowQueueSamples = 0;

function log(event) {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));
}

async function compose(args) {
  const { stdout } = await execFileAsync("docker", ["compose", ...args], {
    maxBuffer: 1024 * 1024 * 4
  });
  return stdout.trim();
}

async function currentWorkers() {
  const output = await compose(["ps", "--format", "json", "worker"]);
  if (!output) {
    return 0;
  }

  return output
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((container) => container.State === "running")
    .length;
}

async function demoState() {
  const response = await fetch(`${baseUrl}/demo-state`, {
    cache: "no-store",
    headers: { "Cache-Control": "no-cache" }
  });
  if (!response.ok) {
    throw new Error(`demo-state returned ${response.status}`);
  }
  return response.json();
}

async function scaleWorkers(target) {
  if (dryRun) {
    log({ decision: "dry_run_scale", targetWorkers: target });
    return;
  }
  await compose(["up", "-d", "--scale", `worker=${target}`, "worker"]);
}

function decide(queueDepth, workers) {
  const backlogPerWorker = workers ? queueDepth / workers : queueDepth;
  const inCooldown = Date.now() - lastScaleAt < cooldownMs;

  if (!inCooldown && queueDepth > 0 && backlogPerWorker > queuePerWorkerTarget && workers < maxWorkers) {
    lowQueueSamples = 0;
    return {
      targetWorkers: Math.min(maxWorkers, workers + 1),
      reason: `queue_per_worker ${backlogPerWorker.toFixed(1)} > ${queuePerWorkerTarget}`
    };
  }

  if (queueDepth <= scaleDownQueueDepth) {
    lowQueueSamples += 1;
  } else {
    lowQueueSamples = 0;
  }

  if (!inCooldown && lowQueueSamples >= 4 && workers > minWorkers) {
    lowQueueSamples = 0;
    return {
      targetWorkers: Math.max(minWorkers, workers - 1),
      reason: `queue_depth <= ${scaleDownQueueDepth} for 4 samples`
    };
  }

  return {
    targetWorkers: workers,
    reason: inCooldown ? "cooldown" : "hold"
  };
}

async function tick() {
  const [state, workers] = await Promise.all([demoState(), currentWorkers()]);
  const backlogPerWorker = workers ? state.queueDepth / workers : state.queueDepth;
  const decision = decide(state.queueDepth, workers);
  const event = {
    metric: "queue_depth_per_worker",
    queueDepth: state.queueDepth,
    workers,
    backlogPerWorker: Number(backlogPerWorker.toFixed(2)),
    targetWorkers: decision.targetWorkers,
    reason: decision.reason
  };

  if (decision.targetWorkers !== workers) {
    await scaleWorkers(decision.targetWorkers);
    lastScaleAt = Date.now();
    log({ ...event, decision: "scale" });
    return;
  }

  log({ ...event, decision: "hold" });
}

async function main() {
  log({
    decision: "start",
    baseUrl,
    minWorkers,
    maxWorkers,
    queuePerWorkerTarget,
    scaleDownQueueDepth,
    pollMs,
    cooldownMs,
    durationMs,
    dryRun
  });

  const endAt = Date.now() + durationMs;
  while (Date.now() < endAt) {
    try {
      await tick();
    } catch (error) {
      log({ decision: "error", error: error.message });
    }
    await new Promise((resolve) => {
      setTimeout(resolve, pollMs);
    });
  }

  log({ decision: "stop" });
}

main().catch((error) => {
  log({ decision: "fatal", error: error.message });
  process.exit(1);
});
