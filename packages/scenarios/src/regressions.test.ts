import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import ts from 'typescript';
import { paymentProvider } from '@actor-cafe/cafe/payment-db';
import {
  advanceCafe,
  startCafe,
  type CafeMessage,
} from '@actor-cafe/cafe/turn';

const config = { customers: 0, baristas: 1, tickMs: 80, inspect: false };
const pay = async () => ({ receiptId: 'test-receipt' });
const arrival = {
  requestId: 'arrival',
  command: { type: 'arrival', drink: 'espresso' },
  acceptedAt: 0,
} satisfies CafeMessage;

test('a lost payment response retries the same charge without recording a decline', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'cafe-lost-payment-'));
  const file = join(directory, 'payments.sqlite');
  const provider = paymentProvider(file);
  context.after(async () => {
    provider.close();
    await rm(directory, { recursive: true, force: true });
  });
  let attempts = 0;
  const loseFirstResponse: typeof provider.pay = async (request) => {
    const receipt = await provider.pay(request);
    if (++attempts === 1) throw new Error('connection reset after commit');
    return receipt;
  };
  const state = await startCafe(
    'lost-response',
    { ...config, customers: 1 },
    0,
    loseFirstResponse,
  );
  assert.ok(state.nextAt !== null);
  await assert.rejects(
    advanceCafe(state, state.nextAt, loseFirstResponse),
    /connection reset after commit/,
  );
  let next = await advanceCafe(state, state.nextAt, loseFirstResponse);
  while (next.nextAt !== null)
    next = await advanceCafe(next, next.nextAt, loseFirstResponse);
  assert.equal(next.snapshot.orders[0]?.status, 'served');
  assert.deepEqual(next.snapshot.payments, [
    { orderId: 'order-1', kind: 'charge' },
  ]);
  assert.equal(attempts, 2);
  const ledger = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(
      ledger.prepare('SELECT COUNT(*) AS count FROM payments').get()?.count,
      1,
    );
  } finally {
    ledger.close();
  }
});

test('a definitive payment decline is recorded without retrying', async () => {
  let attempts = 0;
  const decline = async () => {
    attempts++;
    return { declined: 'Payment denied' };
  };
  let state = await startCafe(
    'declined',
    { ...config, customers: 1 },
    0,
    decline,
  );
  while (state.nextAt !== null)
    state = await advanceCafe(state, state.nextAt, decline);
  assert.equal(attempts, 1);
  assert.equal(state.snapshot.orders[0]?.status, 'failed');
  assert.deepEqual(state.snapshot.payments, []);
});

test('a future command waits behind an earlier timer without reversing logical time', async () => {
  const state = await startCafe(
    'clock-skew',
    { ...config, customers: 1 },
    0,
    pay,
  );
  assert.ok(state.nextAt !== null);
  const deadline = state.nextAt;
  const acceptedAt = deadline + 10;
  const waiting = await advanceCafe(state, deadline - 10, pay, {
    ...arrival,
    acceptedAt,
  });
  assert.deepEqual(waiting.deliveries, []);
  assert.equal(waiting.nextAt, deadline);
  const fired = await advanceCafe(waiting, deadline, pay);
  assert.equal(fired.nextAt, acceptedAt);
  const accepted = await advanceCafe(fired, acceptedAt, pay);
  assert.deepEqual(
    accepted.deliveries.map(({ at, event }) => [at, event.type]),
    [
      [deadline, 'xstate.timer'],
      [acceptedAt, 'arrival'],
    ],
  );
});

test('Vercel offers an already buffered cancellation before an overdue handoff timer', async () => {
  let state = await startCafe('buffered-cancel', config, 0, pay);
  state = await advanceCafe(state, 0, pay, arrival);
  while (
    state.nextAt !== null &&
    !state.snapshot.actors.some((actor) => actor.state === 'working.handingOff')
  )
    state = await advanceCafe(state, state.nextAt, pay);
  assert.ok(state.nextAt !== null);
  let now = state.nextAt + 1;
  let cancelled = false;
  let delivered = false;
  const cancellation: CafeMessage = {
    requestId: 'cancel',
    command: { type: 'cancel', orderId: 'order-1' },
    acceptedAt: state.nextAt - 1,
  };

  // Stub only the workflow scheduler. The workflow and café both run real code.
  const context = createContext({
    Date: class extends Date {
      static now() {
        return now;
      }
    },
  });
  function dependency(exports: Record<string, unknown>) {
    return new SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [name, value] of Object.entries(exports))
          this.setExport(name, value);
      },
      { context },
    );
  }
  const dependencies = new Map([
    [
      'workflow',
      dependency({
        createHook: () => ({
          [Symbol.asyncIterator]: () => ({
            next() {
              if (delivered) return new Promise(() => {});
              delivered = true;
              return Promise.resolve({ done: false, value: cancellation });
            },
          }),
          dispose() {},
        }),
        getStepMetadata: () => ({ stepId: 'test-step' }),
        sleep: async (deadline: Date) => {
          now = deadline.getTime();
        },
      }),
    ],
    [
      '@actor-cafe/cafe/turn',
      dependency({ startCafe: async () => state, advanceCafe }),
    ],
    [
      './storage.ts',
      dependency({
        pay,
        initializeRun: () => state,
        writeRun(_id: string, next: typeof state) {
          if (next.deliveries.length === state.deliveries.length + 1)
            assert.equal(next.deliveries.at(-1)?.event.type, 'cancel');
          const order = next.snapshot.orders[0];
          if (order?.status === 'cancelled') {
            assert.equal(order.refunded, true);
            cancelled = true;
            next.snapshot.status = 'closed';
          }
        },
      }),
    ],
  ]);
  const source = await readFile(
    new URL('../../../apps/workflow/src/workflow.ts', import.meta.url),
    'utf8',
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2023,
    },
  });
  const workflow = new SourceTextModule(outputText, { context });
  await workflow.link((name) => {
    const imported = dependencies.get(name);
    assert.ok(imported, `Unexpected import: ${name}`);
    return imported;
  });
  await workflow.evaluate();
  const namespace = workflow.namespace;
  assert.ok('cafeWorkflow' in namespace);
  const { cafeWorkflow } = namespace;
  assert.ok(typeof cafeWorkflow === 'function');
  await cafeWorkflow(state.id, config);
  assert.equal(cancelled, true);
});
