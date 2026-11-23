import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  cafeSnapshotSchema,
  runtimeSchema,
  type CafeBackend,
  type CafeSnapshot,
  type Command,
} from '@actor-cafe/contract';
import { nativeFixture } from './native.ts';

const timeout = 140_000;
const runtimes =
  process.env.CAFE_RUNTIME === undefined
    ? runtimeSchema.options
    : [runtimeSchema.parse(process.env.CAFE_RUNTIME)];

async function until(
  backend: CafeBackend,
  runId: string,
  description: string,
  ready: (snapshot: CafeSnapshot) => boolean,
) {
  const deadline = Date.now() + 50_000;
  let latest: CafeSnapshot | undefined;
  while (Date.now() < deadline) {
    latest = cafeSnapshotSchema.parse(await backend.snapshot(runId));
    if (ready(latest)) return latest;
    await delay(50);
  }
  assert.fail(
    `Timed out waiting for ${description}. Last snapshot: ${JSON.stringify(
      latest,
    )}`,
  );
}

function send(backend: CafeBackend, runId: string, command: Command) {
  return backend.command(runId, randomUUID(), command);
}

function grindingBaristas(snapshot: CafeSnapshot) {
  const grinding = snapshot.actors.filter(
    (actor) =>
      actor.kind === 'barista' &&
      (actor.state === 'grinding' || actor.state.endsWith('.grinding')),
  );
  assert.ok(grinding.length <= 1, 'Only one barista can grind at a time');
  return grinding;
}

function assertPayments(
  snapshot: CafeSnapshot,
  orderId: string,
  expected: CafeSnapshot['payments'][number]['kind'][],
) {
  const operations = snapshot.payments
    .filter((payment) => payment.orderId === orderId)
    .map((payment) => payment.kind)
    .sort();
  assert.deepEqual(operations, [...expected].sort());
}

for (const runtime of runtimes) {
  test(
    `${runtime}: two baristas contend for one grinder`,
    { timeout },
    async (context) => {
      const { backend } = await nativeFixture(context, runtime, false);
      const runId = randomUUID();
      await backend.start(runId, {
        customers: 0,
        baristas: 2,
        tickMs: 800,
        inspect: false,
      });
      await Promise.all([
        send(backend, runId, { type: 'arrival', drink: 'latte' }),
        send(backend, runId, { type: 'arrival', drink: 'latte' }),
      ]);

      const busy = await until(
        backend,
        runId,
        'two contenders for the grinder',
        (view) => {
          const grinding = grindingBaristas(view);
          return (
            grinding.length === 1 &&
            view.grinder.holder !== null &&
            view.grinder.queued.length > 0
          );
        },
      );
      assert.equal(busy.grinder.queued.length, 1);
      assert.notEqual(busy.grinder.holder, busy.grinder.queued[0]);
      const [holder] = grindingBaristas(busy);
      assert.equal(holder?.id.split('/').at(-1), busy.grinder.holder);

      const done = await until(backend, runId, 'both drinks served', (view) => {
        grindingBaristas(view);
        return (
          view.orders.length === 2 &&
          view.orders.every((order) => order.status === 'served')
        );
      });
      assert.deepEqual(done.grinder, { holder: null, queued: [] });
      assert.equal(done.payments.length, 2);
      for (const order of done.orders)
        assertPayments(done, order.id, ['charge']);
    },
  );

  test(
    `${runtime}: cancellation after payment refunds once`,
    { timeout },
    async (context) => {
      const { backend } = await nativeFixture(context, runtime, false);
      const runId = randomUUID();
      await backend.start(runId, {
        customers: 0,
        baristas: 1,
        tickMs: 800,
        inspect: false,
      });
      await send(backend, runId, { type: 'arrival', drink: 'latte' });

      const before = await until(
        backend,
        runId,
        'a paid order in preparation',
        (view) =>
          view.orders.some(
            (order) => order.status === 'preparing' && order.paid,
          ),
      );
      const order = before.orders.find(
        (order) => order.status === 'preparing' && order.paid,
      );
      assert.ok(order);
      assertPayments(before, order.id, ['charge']);

      await send(backend, runId, { type: 'cancel', orderId: order.id });
      const done = await until(
        backend,
        runId,
        'cancellation and refund',
        (view) =>
          view.orders.some(
            (entry) =>
              entry.id === order.id &&
              entry.status === 'cancelled' &&
              entry.refunded,
          ),
      );
      assert.equal(done.orders.length, 1);
      assert.equal(done.payments.length, 2);
      assertPayments(done, order.id, ['charge', 'refund']);
    },
  );

  test(
    `${runtime}: resumes after a charge commits and the worker is killed`,
    { timeout },
    async (context) => {
      const { backend, crashAndRestart } = await nativeFixture(
        context,
        runtime,
        true,
      );
      const runId = randomUUID();
      await backend.start(runId, {
        customers: 1,
        baristas: 1,
        tickMs: 80,
        inspect: false,
      });
      const interruptedOrder = await crashAndRestart(runId);
      const done = await until(
        backend,
        runId,
        'the interrupted order served',
        (view) =>
          view.orders.some(
            (order) =>
              order.id === interruptedOrder && order.status === 'served',
          ),
      );
      assert.equal(done.orders.length, 1);
      assert.equal(done.payments.length, 1);
      assertPayments(done, interruptedOrder, ['charge']);
    },
  );
}
