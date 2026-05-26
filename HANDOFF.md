# Project Handoff — fault-topology-study

## What this is
Master's thesis project comparing **fault tolerance across 3 microservice communication topologies**. This repo (`fault-topology-study`) is a from-scratch reimplementation I built myself (with Claude's step-by-step guidance) to deeply understand a working reference project (`fault-topology`). Goal: learn the system well enough to write the thesis.

## Architecture
- **4 services**: shop, warehouse, payment, delivery (NestJS + TypeORM + Postgres, one DB per service)
- **1 orchestrator**: stateless coordinator (no DB), used only in sync-orchestrator topology
- **Shared proto**: `proto/order.proto` defines gRPC contracts (`OrderRequest`/`OrderResponse`, one service per microservice). Uses `loader: { keepCase: true }` everywhere to preserve snake_case field names.
- **Single codebase, 3 topologies** switched via `TOPOLOGY` env var:
  - `sync-chain`: shop → warehouse → payment → delivery (blocking gRPC, each forwards to next)
  - `sync-orchestrator`: orchestrator calls each service independently via gRPC; shop just stores the order
  - `async-event`: shop emits `order_created` to RabbitMQ; warehouse → `stock_confirmed` → payment → `payment_completed` → delivery (fire-and-forget)
- Enums for `Topology` and `OrderStatus` in each service to avoid string typos.

## Infra / deployment
- **docker-compose.yml** for local dev (postgres on host port 5433, rabbitmq, all services). Build context is repo root so Dockerfiles can access shared `proto/`.
- **Kubernetes on Minikube**: `k8s/base/` (postgres+PVC, rabbitmq), plus `k8s/sync-chain/`, `k8s/sync-orchestrator/`, `k8s/async-event/` (one Deployment+Service per service per topology).
  - Build images into Minikube's Docker: `eval $(minikube docker-env)` then `docker build -t <svc>-service:latest -f services/<svc>/Dockerfile .`
  - Manifests use `imagePullPolicy: Never` to use local images.
  - Switch topology: `kubectl apply -f k8s/<topology>/` then `kubectl rollout restart deployment/...`
- **Chaos Mesh** installed in `chaos-mesh` namespace. Experiments in `chaos/`.
- **k6 load tests** in `load-tests/` (TypeScript compiled via webpack + ts-loader to `dist/`, run with `k6 run dist/experimentN.js`).

## Current state — WORKING
- All 3 topologies run end-to-end in both docker-compose and Minikube.
- Chaos Mesh experiments run. Experiment 1 (kill payment repeatedly) done:
  - sync-chain: 72/100 success, 28% fail, p95 ~1864ms
  - async-event: 100/100 success, 0 fail, p95 ~2713ms (events buffer in RabbitMQ)
- Results saved to `results/`.

## Bugs already hit & fixed (don't repeat)
- TypeORM: use `url:` not `host:` when passing a full connection string. Don't mix `url` with separate `host/port/db`.
- Env var name mismatches between docker-compose/k8s and the code (e.g. code read `WAREHOUSE_URL` but compose set `WAREHOUSE_GRPC`; `DB_HOST` vs `DATABASE_URL`). Inside Docker/K8s, `localhost` ≠ other services — use service names.
- gRPC snake_case: every gRPC server AND client needs `loader: { keepCase: true }`, else `order_id` → `orderId` and arrives null.
- NestJS `@GrpcMethod` handlers and service methods must `return` their result, else gRPC serializes `undefined` → "Cannot read properties of undefined (reading 'order_id')".
- `createOrder` must `return processOrder(...)` else HTTP responds 201 with empty body.
- Interfaces used in public method return types must be `export`ed.
- RabbitMQ: publisher queue name must match consumer queue name across services. Convention: `order_events_queue` (shop→warehouse), `stock_events_queue` (warehouse→payment), `payment_events_queue` (payment→delivery).
- NestJS Transport.RMQ needs both `amqplib` and `amqp-connection-manager` installed.

## What we're doing NOW — New Relic + thesis metrics
Adding New Relic APM to capture the "inside the system" metrics that k6 can't see. Target **5 metrics across all 3 experiments**:
1. **Network Overhead** — static, counted from design (sync-chain 3 hops, orchestrator 4 calls, async 4 publishes)
2. **Success Rate under Stress** — already from k6 (`http_req_failed`)
3. **Propagation Latency** — chaos start → first user-visible error; New Relic distributed traces
4. **Recovery Time (MTTR)** — pod restart → success rate back to 100% (+ RabbitMQ backlog drained for async)
5. **Failure Propagation Rate** — which/how many services stopped responding; New Relic service map + per-service error rate

### New Relic plan
- Install `newrelic` npm package in each service; require it as the FIRST line of `main.ts` (before anything else).
- Config via env vars: `NEW_RELIC_LICENSE_KEY`, `NEW_RELIC_APP_NAME` (unique per service, ideally suffixed with topology), `NEW_RELIC_DISTRIBUTED_TRACING_ENABLED=true`.
- In K8s, inject license key as a Secret, app name via env per deployment.
- Auto-instrumentation is solid over HTTP; **gRPC and RabbitMQ trace-context propagation may need manual injection/extraction of trace headers** — install first, see what's captured, then patch gaps.

### Experiment methodology reminder
Each experiment needs **baseline** (no chaos) + **chaos** runs, for **both** relevant topologies → 4 runs each. Compare chaos-vs-baseline within a topology (fault impact), then across topologies (which handles faults better).
- Exp 1 — failure isolation: kill payment repeatedly. sync-chain vs async.
- Exp 2 — latency injection: 2s delay on warehouse. sync-orchestrator vs async.
- Exp 3 — DB failure / durability: kill postgres pod. sync-chain vs async. (Postgres has a PVC so data survives the kill.)

## Reference project
The working original is at `/Users/jocho/Desktop/fault-topology` — same structure. Compare against it when stuck, but this repo is the one being actively developed and learned.
