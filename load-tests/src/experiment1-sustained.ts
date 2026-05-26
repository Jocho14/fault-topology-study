import http from "k6/http";
import { check } from "k6";
import { Counter, Trend } from "k6/metrics";
import { Options } from "k6/options";

// Sustained variant of experiment 1 (kill-payment failure isolation).
//
// Unlike the fixed-100-iteration experiment1.ts (which finishes in ~3s and
// cannot span a chaos kill/recover cycle), this drives a CONSTANT ARRIVAL
// RATE for a long duration. Constant arrival rate (not fixed VUs) keeps the
// offered load steady whether requests fast-fail (payment down) or slow down
// (async buffering), so the success-rate timeline in New Relic / k6 lines up
// cleanly against fault-injection and recovery timestamps.
//
// Env knobs:
//   TARGET_URL  shop HTTP endpoint            (default http://localhost:3001)
//   RATE        requests per second           (default 20)
//   DURATION    total run length              (default 3m)
//   MAX_VUS     VU ceiling for in-flight reqs (default 100)
const TARGET_URL = __ENV.TARGET_URL || "http://localhost:3001";
const RATE = parseInt(__ENV.RATE || "20", 10);
const DURATION = __ENV.DURATION || "3m";
const MAX_VUS = parseInt(__ENV.MAX_VUS || "100", 10);

const successCount = new Counter("successful_orders");
const failCount = new Counter("failed_orders");
const orderLatency = new Trend("order_latency", true);

export const options: Options = {
  scenarios: {
    sustained: {
      executor: "constant-arrival-rate",
      rate: RATE,
      timeUnit: "1s",
      duration: DURATION,
      // Enough VUs to cover requests in flight when responses are slow
      // (async p95 was ~2.7s -> ~RATE*3 concurrent). Sized generously.
      preAllocatedVUs: Math.min(RATE * 2, MAX_VUS),
      maxVUs: MAX_VUS,
    },
  },
};

export default function (): void {
  const res = http.post(
    `${TARGET_URL}/orders`,
    JSON.stringify({
      car_model: "Tesla Model 3",
      quantity: 1,
      price: 45000,
      customer_id: `customer-${__VU}-${__ITER}`,
    }),
    { headers: { "Content-Type": "application/json" } },
  );

  orderLatency.add(res.timings.duration);

  const passed = check(res, {
    "status is 2xx": (r) => r.status >= 200 && r.status < 300,
  });

  if (passed) {
    successCount.add(1);
  } else {
    failCount.add(1);
  }
}
