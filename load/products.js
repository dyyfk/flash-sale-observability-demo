import http from "k6/http";
import { check, sleep } from "k6";

const baseUrl = __ENV.BASE_URL || "http://localhost:3000";

export const options = {
  stages: [
    { duration: "15s", target: 20 },
    { duration: "30s", target: 80 },
    { duration: "15s", target: 0 }
  ],
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<150"]
  }
};

export default function () {
  const res = http.get(`${baseUrl}/products`);
  check(res, { "products ok": (r) => r.status === 200 });
  sleep(0.1);
}
