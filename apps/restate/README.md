# Restate café

<!-- Restate service and payment wiring from src/cafe.ts and src/main.ts -->

A keyed `Cafe` Virtual Object runs the shared XState café. An exclusive handler delivers each command or timer. A delayed self-message wakes the object at the next deadline. The object stores the actor journal and the dashboard view. A shared handler reads the view.

The Virtual Object journals each turn with `ctx.run`. The simulated payment provider commits a SQLite receipt keyed by café, order, and operation. A retry after a crash returns that receipt. Stately reconstructs the XState actor tree from committed turns.

## Run locally

<!-- start script in package.json and service configuration in src/main.ts -->

Use `pnpm dev` at the repository root to launch the comparison. To run only the Restate services, use separate terminals:

```sh
restate-server --base-dir .cafe/restate-manual
pnpm --filter @actor-cafe/restate start
```

Register the service once for a new Restate database:

```sh
curl http://127.0.0.1:9070/deployments --json '{"uri":"http://127.0.0.1:9080"}'
```

To point the shared gateway at this server, set `RESTATE_CAFE_INGRESS=http://127.0.0.1:8080` when running `pnpm gateway`. The service listens on loopback. Use `RESTATE_SERVICE_PORT` to change its port, and `RESTATE_PAYMENT_DB` to set the simulated payment ledger path. The default ledger path is `.cafe/restate-payments.sqlite` relative to the service working directory.
