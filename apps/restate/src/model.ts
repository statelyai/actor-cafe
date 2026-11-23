import type { CafeSnapshot, RunConfig } from '@actor-cafe/contract';

type Order = CafeSnapshot['orders'][number];
type Drink = Order['drink'];
type Actor = CafeSnapshot['actors'][number];
export const stations = ['grinder', 'espresso', 'frother'] as const;
const operatingStates = {
  grinder: 'grinding',
  espresso: 'extracting',
  frother: 'frothing',
};
export type Station = (typeof stations)[number];
type Job = { baristaId: string; orderId: string };
type StationQueue = { holding: Job | null; waiting: Job[] };
type Barista = { id: string; orderId: string | null; station: Station | null };

export type Task =
  | { type: 'arrive'; drink: Drink }
  | { type: 'charge'; orderId: string }
  | ({ type: 'brewed'; station: Station } & Job)
  | ({ type: 'serve' } & Job);

export type Schedule = (task: Task, delay?: number) => void;

export type Cafe = {
  config: RunConfig;
  status: CafeSnapshot['status'];
  roomId: string | null;
  revision: number;
  orders: Order[];
  baristas: Barista[];
  equipment: Record<Station, StationQueue>;
  terminal: string | null;
  commands: { id: string; payload: string }[];
};

export function createCafe(config: RunConfig, roomId: string | null): Cafe {
  return {
    config,
    status: 'open',
    roomId,
    revision: 0,
    orders: [],
    baristas: Array.from({ length: config.baristas }, (_, index) => ({
      id: `barista-${index + 1}`,
      orderId: null,
      station: null,
    })),
    equipment: {
      grinder: { holding: null, waiting: [] },
      espresso: { holding: null, waiting: [] },
      frother: { holding: null, waiting: [] },
    },
    terminal: null,
    commands: [],
  };
}

export function arrive(cafe: Cafe, drink: Drink) {
  if (cafe.status !== 'open') return;
  cafe.orders.push({
    id: `order-${cafe.orders.length + 1}`,
    drink,
    paid: false,
    refunded: false,
    status: 'paying',
  });
}

export function findOrder(cafe: Cafe, id: string) {
  return cafe.orders.find((order) => order.id === id);
}

export function cancel(cafe: Cafe, id: string) {
  const order = findOrder(cafe, id);
  if (!order || !['paying', 'queued', 'preparing'].includes(order.status))
    return;
  order.status = 'cancelled';
  if (cafe.terminal === id) cafe.terminal = null;
  const barista = cafe.baristas.find((barista) => barista.orderId === id);
  if (barista) {
    barista.orderId = null;
    barista.station = null;
  }
  for (const queue of Object.values(cafe.equipment)) {
    if (queue.holding?.orderId === id) queue.holding = null;
    queue.waiting = queue.waiting.filter((job) => job.orderId !== id);
  }
  return order;
}

export function completeStation(
  cafe: Cafe,
  task: Extract<Task, { type: 'brewed' }>,
  send: Schedule,
) {
  const slot = cafe.equipment[task.station];
  if (
    slot.holding?.orderId !== task.orderId ||
    slot.holding.baristaId !== task.baristaId
  )
    return;
  const order = findOrder(cafe, task.orderId);
  const barista = cafe.baristas.find(
    (barista) => barista.id === task.baristaId,
  );
  if (!order || !barista)
    throw new Error('Equipment reservation has no order or barista');
  slot.holding = null;
  const next =
    task.station === 'grinder'
      ? 'espresso'
      : task.station === 'espresso' && order.drink === 'latte'
      ? 'frother'
      : null;
  barista.station = next;
  if (next)
    cafe.equipment[next].waiting.push({
      orderId: order.id,
      baristaId: barista.id,
    });
  else
    send(
      { type: 'serve', orderId: order.id, baristaId: barista.id },
      cafe.config.tickMs,
    );
}

export function serveOrder(cafe: Cafe, task: Extract<Task, { type: 'serve' }>) {
  const order = findOrder(cafe, task.orderId);
  const barista = cafe.baristas.find(
    (barista) => barista.id === task.baristaId,
  );
  if (
    order?.status !== 'preparing' ||
    barista?.orderId !== order.id ||
    barista.station !== null
  )
    return;
  order.status = 'served';
  barista.orderId = null;
}

export function scheduleReadyWork(cafe: Cafe, send: Schedule) {
  if (cafe.terminal === null) {
    const next = cafe.orders.find((order) => order.status === 'paying');
    if (next) {
      cafe.terminal = next.id;
      send({ type: 'charge', orderId: next.id }, cafe.config.tickMs);
    }
  }
  for (const barista of cafe.baristas) {
    if (barista.orderId !== null) continue;
    const next = cafe.orders.find((order) => order.status === 'queued');
    if (!next) break;
    next.status = 'preparing';
    barista.orderId = next.id;
    barista.station = 'grinder';
    cafe.equipment.grinder.waiting.push({
      orderId: next.id,
      baristaId: barista.id,
    });
  }
  for (const station of stations) {
    const slot = cafe.equipment[station];
    if (slot.holding !== null) continue;
    const job = slot.waiting.shift();
    if (!job) continue;
    slot.holding = job;
    const ticks = station === 'grinder' ? 5 : station === 'espresso' ? 4 : 2;
    send({ type: 'brewed', station, ...job }, cafe.config.tickMs * ticks);
  }
  if (
    cafe.status === 'closing' &&
    cafe.orders.every(
      ({ status }) =>
        status === 'served' || status === 'cancelled' || status === 'failed',
    )
  )
    cafe.status = 'closed';
}

export function actorsOf(cafe: Cafe): Actor[] {
  return [
    { id: 'cafe', kind: 'cafe', state: cafe.status },
    ...stations.map(
      (id): Actor => ({
        id,
        kind: 'equipment',
        state: cafe.equipment[id].holding ? 'reserved' : 'available',
      }),
    ),
    {
      id: 'terminal',
      kind: 'equipment',
      state: cafe.terminal ? 'reserved' : 'available',
    },
    ...cafe.baristas.map(
      (barista): Actor => ({
        id: barista.id,
        kind: 'barista',
        state:
          barista.orderId === null
            ? 'idle'
            : barista.station === null
            ? 'handoff'
            : cafe.equipment[barista.station].holding?.baristaId === barista.id
            ? operatingStates[barista.station]
            : `waiting-${barista.station}`,
      }),
    ),
    ...cafe.orders.flatMap((order, index): Actor[] => [
      {
        id: `customer-${index + 1}`,
        kind: 'customer',
        state:
          order.status === 'served'
            ? 'served'
            : order.status === 'cancelled' || order.status === 'failed'
            ? 'left'
            : 'waiting',
      },
      { id: order.id, kind: 'order', state: order.status },
      {
        id: `payment-${order.id}`,
        kind: 'payment',
        state: order.refunded
          ? 'refunded'
          : order.paid
          ? 'charged'
          : order.status === 'cancelled'
          ? 'cancelled'
          : cafe.terminal === order.id
          ? 'charging'
          : 'waiting',
      },
    ]),
  ];
}
