import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  stages: [
    { duration: "10s", target: 20 },
    { duration: "20s", target: 150 },
    { duration: "20s", target: 350 },
    { duration: "10s", target: 0 }
  ],
  thresholds: {
    http_req_duration: ["p(95)<400"]
  }
};

export default function () {
  const productId = (__VU % 3) + 1;
  const key = `${__VU}-${__ITER}-${Date.now()}`;
  const res = http.post(
    "http://localhost:3000/orders",
    JSON.stringify({ productId }),
    {
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key
      }
    }
  );
  check(res, {
    "queued or controlled rejection": (r) => [202, 200, 409, 429, 503].includes(r.status)
  });
  sleep(0.05);
}
