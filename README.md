# Actor Café

Actor Café runs one XState v6 actor system on five durable runtimes. Customers order drinks, baristas share equipment, and customers can cancel paid orders.

## Run the comparison

<!-- Workspace entry points from package.json and scripts/dev.ts -->

Install Node 24.17 or later, pnpm, [Restate Server](https://docs.restate.dev/develop/local_dev), and the [Temporal CLI](https://docs.temporal.io/cli). The local launcher starts all five runtimes and stores their data under `.cafe/comparison`.

```sh
pnpm install
pnpm dev:all
```

Open <http://127.0.0.1:5173>. Pick a runtime and start a café. The left pane shows orders, actors, equipment, and payment status. Enable live inspection to show the XState actor tree in Stately on the right. The hosted Inspector receives synthetic demo state. Anyone with the viewer link can view that run.

Use `pnpm dev` for Rivet and Restate, or `CAFE_RIVET_ONLY=1 pnpm dev` for Rivet alone. The [Rivet CLI](apps/rivet/README.md) also runs independently.

## What each runtime owns

<!-- Runtime boundaries from apps, packages/cafe, and scripts/gateway.ts -->

All five import [the same café machine factory](packages/cafe/src/model.ts), which defines the café, customers, orders, baristas, equipment, and payments. Each host owns one café run. The XState child actors share that run and communicate within it.

| Runtime | Native primitives | Example |
| --- | --- | --- |
| Rivet | Actor queue, workflow steps, per-actor SQLite, payment actor | [Registry](apps/rivet/src/rivet/registry.ts) |
| Restate | Virtual Object, exclusive commands, delayed self-messages, journaled effects | [Service](apps/restate/src/cafe.ts) |
| Cloudflare | Durable Object, storage transaction with one alarm, separate payment object | [Worker](apps/cloudflare/src/worker.ts) |
| Temporal | Workflow signals, durable timer condition, Activities, snapshot query | [Workflow](apps/temporal/src/workflow.ts) |
| Vercel Workflow | Workflow hooks, durable sleep, steps, local SQLite read model | [Workflow](apps/workflow/src/workflow.ts) |

The Rivet example began in [rivet-xstate](https://github.com/davidkpiano/rivet-xstate/pull/8). All examples use simulated payments. The Temporal and Vercel examples use local SQLite for the simulated provider. A hosted multi-worker deployment needs shared durable storage for that provider and, for Vercel, the read model.

See the [comparison notes and XState upstream gaps](docs/durable-execution.md).

## Verify

<!-- Shared scenarios from packages/scenarios and test scripts from package.json -->

```sh
pnpm typecheck
pnpm build
pnpm test:scenarios
pnpm test
```

The shared suite runs the same three scenarios against each local runtime. It checks grinder contention, one refund after cancellation, and recovery after a worker dies following a committed charge. The suite also covers lost payment responses, command and timer ordering, malformed Restate requests, and duplicate workflow starts. `pnpm test` also runs the original Rivet and SQLite regression suites. To select one runtime, run `CAFE_RUNTIME=cloudflare pnpm test:scenarios`. Use `TEMPORAL_CLI` or `RESTATE_SERVER` to override either server executable.
