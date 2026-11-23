# Actor Café

Actor Café compares durable actor and workflow runtimes through a café simulation. Customers order drinks, baristas share equipment, and orders can be cancelled after payment.

<!-- workspace entry points from package.json and scripts/dev.ts -->

## Run the comparison

Install Node 24.17 or later, pnpm, and [Restate Server](https://docs.restate.dev/develop/local_dev). The Restate tests were run with server 1.4.3.

```sh
pnpm install
pnpm dev
```

Open <http://localhost:5173>. Pick a runtime and start a café. The left pane shows orders, actors, grinder reservations, and payment status. Select live inspection when starting a run to load the Stately Inspector in the right pane. The hosted Inspector receives synthetic demo state. Anyone with the viewer link can view that run.

The dev launcher starts both local runtimes and stores their data under `.cafe/`. Use `CAFE_RIVET_ONLY=1 pnpm dev` to run without Restate Server. The [Rivet CLI](apps/rivet/README.md) also runs on its own.

<!-- runtime boundaries from apps/rivet, apps/restate, packages/contract, and scripts/gateway.ts -->

## Implementations

- [XState + Rivet](apps/rivet/README.md) runs the XState actor tree in a Rivet actor through `run: xstate(...)`. The Inspector shows the actual XState actors and their machine state.
- [Restate](apps/restate/README.md) uses a keyed Virtual Object to coordinate one café. Durable messages schedule work and a separate payment service handles effects. Stately shows a manual projection of the persisted café entities.

The Rivet version was imported from [rivet-xstate at the XState beta upgrade](https://github.com/davidkpiano/rivet-xstate/tree/8b3ff42c71cd0c86b8b02379c73b0a310d72dbf4/examples/cafe). The runtimes share API and observation schemas in `packages/contract`. Each runtime owns its own domain logic and state. The shared scenarios define the behavior compared here. Equipment breakdowns and customer patience are Rivet demo features.

<!-- shared scenarios from packages/scenarios and test scripts from package.json -->

## Verify

```sh
pnpm typecheck
pnpm build
pnpm test:scenarios
pnpm test
```

The same three scenarios run against native Rivet and Restate processes.

1. Two baristas contend for one grinder. Both orders complete, with one charge each.
2. A customer cancels a paid order. The order ends cancelled and has one charge and one refund.
3. A worker dies after a charge commits and before its result is recorded. The same run resumes and records one effective charge.

The scenario tests start isolated local runtimes and use synthetic payments. The full suite also runs the imported Rivet and SQLite recovery tests.
