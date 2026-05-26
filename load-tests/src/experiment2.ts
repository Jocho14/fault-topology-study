import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Counter } from "k6/metrics";
import { Options } from "k6/options";

const orderLatency = new Trend("order_latency", true);
const successCount = new Counter("successful_orders");
const failCount = new Counter("failed_orders");
const TARGET_URL = __ENV.TARGET_URL || "http://localhost:3005";

export const options: Options = {
  vus: 10,
  duration: "60s",
};

export default function (): void {
  const res = http.post(
    `${TARGET_URL}/orders`,
    JSON.stringify({
      car_model: "BMW M3",
      quantity: 1,
      price: 72000,
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

  sleep(0.5);
}
