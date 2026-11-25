import { z } from 'zod';
import type { CafeSnapshot } from '@actor-cafe/contract';
import type { OrderStatus } from './model.ts';

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

export function projectCafe(
  view: {
    status: string;
    actors: {
      id: string;
      address: string;
      value?: unknown;
      status: string;
      context?: unknown;
    }[];
  },
  payments: CafeSnapshot['payments'],
  inspectorUrl: string | null = null,
): CafeSnapshot {
  const root = cafeContext.parse(
    view.actors.find((actor) => actor.id === 'cafe')?.context,
  );
  const grinder = grinderContext.parse(
    view.actors.find((actor) => actor.id === 'grinder')?.context,
  );
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
    payments,
    inspectorUrl,
  };
}
