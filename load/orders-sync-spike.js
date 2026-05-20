import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  stages: [
    { duration: "10s", target: 20 },
    { duration: "20s", target: 120 },
    { duration: "20s", target: 240 },
    { duration: "10s", target: 0 }
  ],
  thresholds: {
    http_req_duration: ["p(95)<800"]
  }
};

export default function () {
  const productId = (__VU % 3) + 1;
  const key = `sync-${__VU}-${__ITER}-${Date.now()}`;
  const res = http.post(
    "http://localhost:3000/orders-sync",
    JSON.stringify({ productId }),
    {
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key
      }
    }
  );
  check(res, {
    "processed or controlled rejection": (r) => [201, 200, 409, 429].includes(r.status)
  });
  sleep(0.05);
}
