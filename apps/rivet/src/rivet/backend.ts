import { setTimeout as delay } from 'node:timers/promises';
import type { CafeBackend, CafeSnapshot } from '@actor-cafe/contract';
import { createClient } from 'rivetkit/client';
import { z } from 'zod';
import type { OrderStatus } from '../model.ts';
import { createCafeRegistry } from './registry.ts';
import { retryIdempotentRivetRequest as retry } from './requests.ts';

const orderStatus = {
  charging: 'paying',
  queued: 'queued',
  preparing: 'preparing',
  refunding: 'preparing',
  served: 'served',
  cancelled: 'cancelled',
  paymentFailed: 'failed',
  refundFailed: 'failed',
} satisfies Record<OrderStatus, CafeSnapshot['orders'][number]['status']>;

const cafeContext = z.object({
  closing: z.boolean(),
  orders: z.record(
    z.string(),
    z.object({
      drink: z.enum(['espresso', 'latte']),
      status: z.enum([
        'charging',
        'queued',
        'preparing',
        'refunding',
        'served',
        'cancelled',
        'paymentFailed',
        'refundFailed',
      ]),
      paid: z.boolean(),
      refundReceiptId: z.string().nullable(),
    }),
  ),
});
const reservation = z.object({ ownerId: z.string() });
const grinderContext = z.object({
  holder: reservation.nullable(),
  queue: z.array(reservation),
});

const equipment = new Set(['grinder', 'espresso', 'frother', 'terminal']);
function actorKind(id: string): CafeSnapshot['actors'][number]['kind'] {
  if (id === 'cafe') return 'cafe';
  if (equipment.has(id)) return 'equipment';
  if (id.startsWith('customer-')) return 'customer';
  if (id.startsWith('barista-')) return 'barista';
  if (id.startsWith('order-')) return 'order';
  return 'payment';
}

function statePath(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return undefined;
  return Object.entries(value)
    .map(([parent, child]) => {
      const path = statePath(child);
      return path ? `${parent}.${path}` : parent;
    })
    .join(', ');
}

export function createRivetBackend(
  endpoint: string,
): CafeBackend & { dispose(): Promise<void> } {
  const client = createClient<ReturnType<typeof createCafeRegistry>>(endpoint);

  async function snapshot(id: string): Promise<CafeSnapshot> {
    const cafe = client.cafe.get([id]);
    const view = await retry(() => cafe.getSnapshot());
    if (!view)
      throw new Error('The café has not published its first snapshot.');
    const root = cafeContext.parse(
      view.actors.find((actor) => actor.id === 'cafe')?.context,
    );
    const grinder = grinderContext.parse(
      view.actors.find((actor) => actor.id === 'grinder')?.context,
    );
    const { executionId } = await retry(() => cafe.info());
    const ledger = client.payments.getOrCreate([executionId]);
    const payments = await retry(() => ledger.receipts());
    return {
      status:
        view.status === 'done' ? 'closed' : root.closing ? 'closing' : 'open',
      orders: Object.entries(root.orders).map(([id, order]) => ({
        id,
        drink: order.drink,
        status: orderStatus[order.status],
        paid: order.paid,
        refunded: order.refundReceiptId !== null,
      })),
      actors: view.actors.map((actor) => ({
        id: actor.address,
        kind: actorKind(actor.id),
        state: statePath(actor.value) || actor.status,
      })),
      grinder: {
        holder: grinder.holder?.ownerId ?? null,
        queued: grinder.queue.map(({ ownerId }) => ownerId),
      },
      payments: payments.map(({ orderId, kind }) => ({ orderId, kind })),
      inspectorUrl: view.inspectorUrl,
    };
  }

  return {
    async start(id, { inspect, ...config }) {
      const cafe = client.cafe.getOrCreate([id], {
        createWithInput: { config, inspect },
      });
      await retry(() => cafe.info());
      const deadline = Date.now() + 20_000;
      while (!(await retry(() => cafe.getSnapshot()))) {
        if (Date.now() >= deadline)
          throw new Error('The café did not publish its initial snapshot.');
        await delay(50);
      }
    },
    async command(id, requestId, command) {
      await retry(() => client.cafe.get([id]).dispatch(command, requestId));
    },
    snapshot,
    dispose: () => client.dispose(),
  };
}
