import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";
import { Options } from "k6/options";

const successCount = new Counter("successful_orders");
const failCount = new Counter("failed_orders");
const TARGET_URL = __ENV.TARGET_URL || "http://localhost:3001";

export const options: Options = {
  // Fixed 100 requests: 10 VUs × 10 iterations each
  vus: 10,
  iterations: 100,
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

  const passed = check(res, {
    "status is 2xx": (r) => r.status >= 200 && r.status < 300,
  });

  if (passed) {
    successCount.add(1);
  } else {
    failCount.add(1);
  }
}
