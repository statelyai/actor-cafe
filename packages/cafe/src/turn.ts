import type { CafeSnapshot, Command, RunConfig } from '@actor-cafe/contract';
import {
  JournalExecution,
  type Delivery,
  type LogicResult,
} from '@demo/xstate-durable/journal';
import {
  cafeInputSchema,
  createCafeMachine,
  type CafeServices,
} from './model.ts';
import { projectCafe } from './projection.ts';

export type Payment = CafeSnapshot['payments'][number];
export type PaymentRequest = Payment & { cafeId: string; amount: number };
export type PaymentOutcome = { receiptId: string } | { declined: string };
export type Pay = (request: PaymentRequest) => Promise<PaymentOutcome>;

class PaymentDeclined extends Error {}

export type CafeMessage = {
  requestId: string;
  command: Command;
  acceptedAt: number;
};

export type CafeRun = {
  id: string;
  config: RunConfig;
  startedAt: number;
  deliveries: Delivery[];
  results: Record<string, LogicResult>;
  receipts: Payment[];
  inbox: CafeMessage[];
  accepted: Record<string, Command['type']>;
  nextAt: number | null;
  snapshot: CafeSnapshot;
};

function execution(state: CafeRun, lookupPay: () => Pay | undefined) {
  function operation(kind: Payment['kind']): CafeServices['charge'] {
    return async (request) => {
      const pay = lookupPay();
      if (!pay)
        throw new Error('Historical execution cannot charge or refund.');
      const receipt = await pay({ cafeId: state.id, kind, ...request });
      if ('declined' in receipt) throw new PaymentDeclined(receipt.declined);
      state.receipts.push({ orderId: request.orderId, kind });
      return receipt;
    };
  }
  return new JournalExecution({
    executionId: state.id,
    startedAt: state.startedAt,
    input: cafeInputSchema.parse(state.config),
    logic: createCafeMachine({
      charge: operation('charge'),
      refund: operation('refund'),
    }),
    retryError: (error) => !(error instanceof PaymentDeclined),
    journal: async (key, run) => {
      if (Object.hasOwn(state.results, key)) return state.results[key];
      if (!lookupPay())
        throw new Error(`Missing recorded effect outcome: ${key}`);
      const result = await run();
      state.results[key] = result;
      return result;
    },
  });
}

export async function restoreCafe(state: CafeRun) {
  const replay = execution(state, () => undefined);
  await replay.start();
  for (const delivery of state.deliveries) await replay.deliver(delivery);
  return replay;
}

export async function startCafe(
  id: string,
  config: RunConfig,
  now: number,
  pay: Pay,
): Promise<CafeRun> {
  const state: CafeRun = {
    id,
    config,
    startedAt: now,
    deliveries: [],
    results: {},
    receipts: [],
    inbox: [],
    accepted: {},
    nextAt: null,
    snapshot: {
      status: 'open',
      orders: [],
      actors: [],
      grinder: { holder: null, queued: [] },
      payments: [],
      inspectorUrl: null,
    },
  };
  const run = execution(state, () => pay);
  await run.start();
  state.nextAt = run.nextTimer?.at ?? null;
  state.snapshot = projectCafe(run.view(), state.receipts);
  return state;
}

export async function advanceCafe(
  previous: CafeRun,
  now: number,
  pay: Pay,
  message?: CafeMessage,
): Promise<CafeRun> {
  const state = structuredClone(previous);
  if (state.snapshot.status === 'closed') return state;
  if (message && !Object.hasOwn(state.accepted, message.requestId)) {
    Object.defineProperty(state.accepted, message.requestId, {
      value: message.command.type,
      enumerable: true,
    });
    state.inbox.push(message);
  }
  let live = false;
  const run = execution(state, () => (live ? pay : undefined));
  await run.start();
  for (const delivery of state.deliveries) await run.deliver(delivery);
  live = true;
  const timer = run.nextTimer;
  const timerAt = timer && Math.max(run.now, timer.at);
  const next = state.inbox[0];
  const acceptedAt = next && Math.max(run.now, next.acceptedAt);
  let delivery: Delivery | undefined;
  if (
    timer &&
    timerAt !== undefined &&
    timerAt <= now &&
    (acceptedAt === undefined || timerAt <= acceptedAt)
  ) {
    delivery = { ...timer, at: timerAt };
  } else if (next && acceptedAt !== undefined && acceptedAt <= now) {
    delivery = {
      address: run.execution.rootAddress,
      at: acceptedAt,
      event: next.command,
      commandId: next.requestId,
    };
    state.inbox.shift();
  }
  if (delivery) {
    await run.deliver(delivery);
    state.deliveries.push(delivery);
  }
  state.snapshot = projectCafe(run.view(), state.receipts);
  const nextAt = Math.min(
    run.nextTimer?.at ?? Infinity,
    state.inbox[0]?.acceptedAt ?? Infinity,
  );
  state.nextAt =
    state.snapshot.status === 'closed' || nextAt === Infinity
      ? null
      : Math.max(run.now, nextAt);
  return state;
}
