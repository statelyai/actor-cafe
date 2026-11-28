import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request } from 'node:http';
import { connect } from 'node:http2';
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
    (actor) => actor.kind === 'barista' && actor.state === 'working.grinding',
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
        customers: 2,
        baristas: 2,
        tickMs: 1_500,
        inspect: false,
      });

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
      assert.deepEqual(
        [...new Set(busy.actors.map(({ kind }) => kind))].sort(),
        ['barista', 'cafe', 'customer', 'equipment', 'order', 'payment'],
      );
      assert.ok(
        busy.actors.some(
          (actor) => actor.state === 'working.waitingForGrinder',
        ),
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

if (runtimes.includes('restate')) {
  test(
    'restate: invalid ingress requests return 400 and leave the café responsive',
    { timeout },
    async (context) => {
      const { backend, ingress } = await nativeFixture(
        context,
        'restate',
        false,
      );
      assert.ok(ingress);
      const id = randomUUID();
      const endpoint = new URL(`/Cafe/${id}/`, ingress);
      async function invalid(handler: string, body: unknown) {
        const response = await fetch(new URL(handler, endpoint), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(3_000),
        });
        await response.text();
        assert.equal(
          response.status,
          400,
          `Invalid ${handler} should be terminal`,
        );
      }
      await invalid('start', { customers: 'unlimited' });
      await backend.start(id, {
        customers: 0,
        baristas: 1,
        tickMs: 80,
        inspect: false,
      });
      await invalid('command', {
        requestId: 'bad',
        command: { type: 'refill' },
      });
      await send(backend, id, { type: 'close' });
      assert.equal((await backend.snapshot(id)).status, 'closed');
    },
  );
}

for (const runtime of ['temporal', 'workflow'] as const) {
  if (!runtimes.includes(runtime)) continue;
  test(
    `${runtime}: concurrent and repeated starts preserve the café ID after close`,
    { timeout },
    async (context) => {
      const { backend } = await nativeFixture(context, runtime, false);
      const id = randomUUID();
      const config = { customers: 0, baristas: 1, tickMs: 80, inspect: false };
      await Promise.all([backend.start(id, config), backend.start(id, config)]);
      await send(backend, id, { type: 'arrival', drink: 'latte' });
      await until(
        backend,
        id,
        'the original order served',
        (view) => view.orders[0]?.status === 'served',
      );
      await send(backend, id, { type: 'close' });
      const closed = await until(
        backend,
        id,
        'the original café closed',
        (view) => view.status === 'closed',
      );
      await backend.start(id, { ...config, customers: 1 });
      // A bad second start can return the old snapshot while its new run initializes.
      for (let observation = 0; observation < 20; observation++) {
        assert.deepEqual(await backend.snapshot(id), closed);
        await delay(100);
      }
    },
  );
}

if (runtimes.includes('restate')) {
  test(
    'restate: SIGTERM bounds shutdown with an active HTTP/2 stream',
    { timeout },
    async (context) => {
      const { endpoint, shutdown } = await nativeFixture(
        context,
        'restate',
        false,
      );
      assert.ok(endpoint && shutdown);
      const session = connect(endpoint);
      try {
        const stream = session.request(
          {
            ':method': 'POST',
            ':path': '/invoke/Cafe/start',
            'content-type': 'application/vnd.restate.invocation.v5',
          },
          { endStream: false },
        );
        const [headers] = await once(stream, 'response', {
          signal: AbortSignal.timeout(3000),
        });
        assert.equal(headers[':status'], 200);
        assert.equal(stream.closed, false);
        await shutdown();
      } finally {
        session.destroy();
      }
    },
  );
}

if (runtimes.includes('temporal')) {
  test(
    'temporal: a body on GET returns 400 and leaves the worker responsive',
    { timeout },
    async (context) => {
      const { backend, endpoint } = await nativeFixture(
        context,
        'temporal',
        false,
      );
      assert.ok(endpoint);
      const id = randomUUID();
      await backend.start(id, {
        customers: 0,
        baristas: 1,
        tickMs: 80,
        inspect: false,
      });
      const status = await new Promise<number | undefined>(
        (resolve, reject) => {
          const req = request(
            new URL(`/api/runs/${id}/snapshot`, endpoint),
            {
              method: 'GET',
              headers: { 'content-length': '1' },
              signal: AbortSignal.timeout(3000),
            },
            (response) => {
              response.resume();
              resolve(response.statusCode);
            },
          );
          req.on('error', reject);
          req.end('x');
        },
      );
      assert.equal(status, 400);
      assert.equal((await backend.snapshot(id)).status, 'open');
    },
  );
}
