# Load Test Results

These runs were executed locally on a Colima Docker VM with 2 CPUs and 4 GB memory. The goal was not to produce universal benchmark numbers, but to demonstrate a repeatable saturation method and identify failure modes.

## Test

```bash
k6 run --summary-export results/baseline-1api-1worker.json load/orders-spike.js
docker compose up --scale api=3 --scale worker=3
k6 run --summary-export results/scaled-3api-3worker.json load/orders-spike.js
```

The test ramps to 350 virtual users over one minute and continuously creates async orders through the Nginx gateway.

## Results

| Topology | Request rate | p90 latency | p95 latency | HTTP failure rate | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| 1 API / 1 worker | 332.5 req/s | 796 ms | 987 ms | 13.7% | Saturated around the high-200s VU range; Nginx/API began returning EOF under heavy connection pressure. |
| 3 API / 3 workers | 117.6 req/s | 1.05 s | 2.38 s | 34.3% | Worse on the 2-CPU local VM because extra containers increased host contention and Postgres/Redis pressure. |

## Interpretation

The useful production lesson is that scaling is not automatically an improvement. On this laptop-sized VM, adding API and worker replicas moved the bottleneck from a single API process toward shared host CPU, Postgres, Redis, and gateway connection pressure.

The visible failure mode was not overselling inventory. Atomic Postgres updates protected correctness. The failure mode was availability and latency: p95 latency rose sharply, the queue accumulated, and the gateway started closing connections under load.

## Improvement Made

After observing the failure mode, the API was changed to reject new orders with a controlled `503 queue_full` response when Redis queue depth exceeds `MAX_QUEUE_DEPTH`. This is a backpressure mechanism: it protects the API and database from accepting more work than the workers can drain.

That is the production tradeoff I would explain in the interview: fail fast and visibly when saturated, rather than letting user requests hang, pile up, and fail unpredictably.

## Next Measurements

The next run should compare the same 350-VU spike with `MAX_QUEUE_DEPTH` enabled and report:

- accepted order rate
- controlled `503 queue_full` rate
- p95 API latency
- max Redis queue depth
- worker drain rate after the spike
