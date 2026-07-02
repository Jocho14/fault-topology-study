import http from "k6/http";
import { check } from "k6";
import { Counter, Trend } from "k6/metrics";
import { Options } from "k6/options";

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
      preAllocatedVUs: Math.min(RATE * 2, MAX_VUS),
      maxVUs: MAX_VUS,
    },
  },
};

export default function (): void {
  const res = http.post(
    `${TARGET_URL}/orders`,
    JSON.stringify({
      car_model: "Porsche 911",
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
