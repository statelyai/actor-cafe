# Restate café

<!-- Restate service definitions in src/cafe.ts and src/payment.ts -->

A keyed `Cafe` Virtual Object owns one café's orders, baristas, and equipment. Exclusive handlers serialize changes within the café. A shared handler reads its current view. Delayed Restate messages move customers through arrival, payment, brewing, and handoff without holding one invocation open per customer.

The `Payments` service wraps the simulated provider in a durable step. The provider keeps a SQLite receipt per café, order, and operation. When the service restarts after the provider commits a charge, retrying returns the existing receipt. Cafe cancellation issues a refund for a paid order that has yet to be served.

Stately shows a projection of the coordinator's customers, orders, equipment, and payments. The projection publishes their states and hierarchy. Restate persists them together inside the café Virtual Object. Enable inspection to stream demo state to the configured Stately relay.

## Run locally

<!-- start script in package.json and service configuration in src/main.ts -->

From the repository root, start Restate Server and the service in separate terminals:

```sh
restate-server --base-dir .cafe/restate
pnpm --filter @actor-cafe/restate start
```

Register the service once for a new Restate database:

```sh
curl http://127.0.0.1:9070/deployments --json '{"uri":"http://127.0.0.1:9080"}'
```

The shared café app uses the Restate ingress at `http://127.0.0.1:8080`. The service listens on loopback. Use `RESTATE_SERVICE_PORT` to change its port, and `RESTATE_PAYMENT_DB` to set the simulated payment ledger path. The default ledger path is `.cafe/restate-payments.sqlite` relative to the service working directory.
