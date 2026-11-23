import { randomUUID } from 'node:crypto';
import * as restate from '@restatedev/restate-sdk';
import {
  commandSchema,
  runConfigSchema,
  type CafeSnapshot,
} from '@actor-cafe/contract';
import { z } from 'zod';
import {
  actorsOf,
  arrive,
  cancel,
  completeStation,
  createCafe,
  findOrder,
  scheduleReadyWork,
  serveOrder,
  stations,
  type Cafe,
  type Schedule,
} from './model.ts';
import type { createInspection } from './inspection.ts';
import type { createPayments } from './payment.ts';

const drinkSchema = z.enum(['latte', 'espresso']);
const chargeSchema = z.object({
  type: z.literal('charge'),
  orderId: z.string(),
});
const fields = { orderId: z.string(), baristaId: z.string() };
const taskSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('arrive'), drink: drinkSchema }),
  chargeSchema,
  z.object({ type: z.literal('brewed'), station: z.enum(stations), ...fields }),
  z.object({ type: z.literal('serve'), ...fields }),
]);
const inputSchema = z.object({
  requestId: z.string().min(1),
  command: commandSchema,
});

export const cafeServiceName = 'Cafe';
type State = { cafe: Cafe };
type Context = restate.ObjectContext<State>;
type SharedContext = restate.ObjectSharedContext<State>;

function parse<T>(schema: z.ZodType<T>, payload: unknown): T {
  const result = schema.safeParse(payload);
  if (!result.success)
    throw new restate.TerminalError(result.error.message, { errorCode: 400 });
  return result.data;
}

async function load(ctx: Context | SharedContext) {
  const cafe = await ctx.get('cafe');
  if (cafe === null)
    throw new restate.TerminalError('Café does not exist', { errorCode: 404 });
  return cafe;
}

function schedule(ctx: Context): Schedule {
  return (task, delay) => {
    ctx.genericSend({
      service: cafeServiceName,
      method: 'advance',
      key: ctx.key,
      parameter: task,
      inputSerde: restate.serde.json,
      delay,
    });
  };
}

function amount(drink: 'latte' | 'espresso') {
  return drink === 'latte' ? 550 : 350;
}

export function createCafeService(
  payments: ReturnType<typeof createPayments>,
  inspection: ReturnType<typeof createInspection>,
) {
  function publish(
    ctx: Context | SharedContext,
    cafe: Cafe,
    actors = actorsOf(cafe),
  ) {
    const roomId = cafe.roomId;
    if (roomId === null) return null;
    return ctx.run('publish inspection', () => {
      try {
        return inspection.publish(roomId, cafe.revision, actors);
      } catch (error) {
        console.warn('Could not publish café inspection:', error);
        return null;
      }
    });
  }

  async function save(ctx: Context, cafe: Cafe) {
    cafe.revision++;
    ctx.set('cafe', cafe);
    await publish(ctx, cafe);
  }

  return restate.object({
    name: cafeServiceName,
    handlers: {
      start: async (ctx: Context, input: unknown) => {
        const config = parse(runConfigSchema, input);
        const current = await ctx.get('cafe');
        if (current !== null) {
          if (JSON.stringify(current.config) !== JSON.stringify(config)) {
            throw new restate.TerminalError(
              'Café already exists with another configuration',
              { errorCode: 409 },
            );
          }
          return;
        }
        const roomId = config.inspect
          ? await ctx.run('allocate inspection room', randomUUID)
          : null;
        const cafe = createCafe(config, roomId);
        for (let index = 0; index < config.customers; index++) {
          schedule(ctx)(
            { type: 'arrive', drink: index % 2 === 0 ? 'latte' : 'espresso' },
            index * config.tickMs * 2,
          );
        }
        await save(ctx, cafe);
      },
      command: async (ctx: Context, input: unknown) => {
        const { requestId, command } = parse(inputSchema, input);
        const cafe = await load(ctx);
        const payload = JSON.stringify(command);
        const existing = cafe.commands.find((entry) => entry.id === requestId);
        if (existing) {
          if (existing.payload !== payload) {
            throw new restate.TerminalError(
              'Request ID already belongs to another command',
              { errorCode: 409 },
            );
          }
          return;
        }
        const send = schedule(ctx);
        if (command.type === 'arrival') {
          if (cafe.status !== 'open') {
            throw new restate.TerminalError('Café is closing or closed', {
              errorCode: 409,
            });
          }
          arrive(cafe, command.drink);
        } else if (command.type === 'close') {
          if (cafe.status === 'open') cafe.status = 'closing';
        } else {
          const order = cancel(cafe, command.orderId);
          if (order?.paid) {
            await ctx.serviceClient(payments).pay({
              cafeId: ctx.key,
              orderId: order.id,
              amount: amount(order.drink),
              kind: 'refund',
            });
            order.refunded = true;
          }
        }
        cafe.commands.push({ id: requestId, payload });
        scheduleReadyWork(cafe, send);
        await save(ctx, cafe);
      },
      advance: async (ctx: Context, input: unknown) => {
        const task = parse(taskSchema, input);
        const cafe = await load(ctx);
        const send = schedule(ctx);
        switch (task.type) {
          case 'arrive':
            arrive(cafe, task.drink);
            break;
          case 'charge': {
            const order = findOrder(cafe, task.orderId);
            if (cafe.terminal !== task.orderId || order?.status !== 'paying')
              return;
            await ctx.serviceClient(payments).pay({
              cafeId: ctx.key,
              orderId: order.id,
              amount: amount(order.drink),
              kind: 'charge',
            });
            order.paid = true;
            order.status = 'queued';
            cafe.terminal = null;
            break;
          }
          case 'brewed':
            completeStation(cafe, task, send);
            break;
          case 'serve':
            serveOrder(cafe, task);
            break;
        }
        scheduleReadyWork(cafe, send);
        await save(ctx, cafe);
      },
      snapshot: restate.handlers.object.shared(
        async (ctx: SharedContext): Promise<CafeSnapshot> => {
          const cafe = await load(ctx);
          const actors = actorsOf(cafe);
          const grinder = cafe.equipment.grinder;
          return {
            status: cafe.status,
            orders: cafe.orders,
            actors,
            grinder: {
              holder: grinder.holding?.baristaId ?? null,
              queued: grinder.waiting.map((job) => job.baristaId),
            },
            payments: await ctx.serviceClient(payments).list(ctx.key),
            inspectorUrl: await publish(ctx, cafe, actors),
          };
        },
      ),
    },
  });
}
