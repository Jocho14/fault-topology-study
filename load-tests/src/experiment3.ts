import http from "k6/http";
import { check } from "k6";
import { Counter, Trend } from "k6/metrics";
import { Options } from "k6/options";

// Experiment 3 load: constant arrival rate sustained for the full run, so the
// offered request rate is independent of system latency / failure mode (same
// pattern as experiment1-sustained.ts). The orchestrator script applies the
// payment<->postgres partition mid-run.
//
// Env knobs:
//   TARGET_URL  shop HTTP endpoint            (default http://localhost:3001)
//   RATE        requests per second           (default 20)
//   DURATION    total run length              (default 255s — 45 baseline +
//                                              60 chaos + 120 recovery + 30 drain)
//   MAX_VUS     VU ceiling for in-flight reqs (default 100)
const TARGET_URL = __ENV.TARGET_URL || "http://localhost:3001";
const RATE = parseInt(__ENV.RATE || "20", 10);
const DURATION = __ENV.DURATION || "255s";
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
      preAllocatedVUs: Math.min(RATE * 2, MAX_VUS),
      maxVUs: MAX_VUS,
    },
  },
};

export default function (): void {
  const res = http.post(
    `${TARGET_URL}/orders`,
    JSON.stringify({
      car_model: "Audi A4",
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
