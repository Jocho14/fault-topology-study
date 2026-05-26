import http from "k6/http";
import { check, sleep } from "k6";
import { Counter } from "k6/metrics";
import { Options } from "k6/options";

const successCount = new Counter("successful_orders");
const failCount = new Counter("failed_orders");
const TARGET_URL = __ENV.TARGET_URL || "http://localhost:3001";

export const options: Options = {
  // 3 stages: before failure, during failure, after recovery
  stages: [
    { duration: "15s", target: 10 }, // ramp up — normal traffic
    { duration: "30s", target: 10 }, // sustained — apply chaos during this window
    { duration: "15s", target: 10 }, // recovery — DB should be back
  ],
};

export default function (): void {
  const res = http.post(
    `${TARGET_URL}/orders`,
    JSON.stringify({
      car_model: "Audi RS6",
      quantity: 1,
      price: 120000,
      customer_id: `customer-${__VU}-${__ITER}`,
    }),
    { headers: { "Content-Type": "application/json" } },
  );

  const passed = check(res, {
    "status is 2xx": (r) => r.status >= 200 && r.status < 300,
  });

  if (passed) {
    successCount.add(1);
  } else {
    failCount.add(1);
  }

  sleep(0.2);
}
