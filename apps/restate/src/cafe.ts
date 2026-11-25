import * as restate from '@restatedev/restate-sdk';
import { runConfigSchema } from '@actor-cafe/contract';
import { messageSchema } from '@actor-cafe/cafe/http';
import {
  advanceCafe,
  startCafe,
  type CafeRun,
  type Pay,
} from '@actor-cafe/cafe/turn';
import type { createInspection } from '@actor-cafe/cafe/inspection';

export function createCafeService(
  pay: Pay,
  inspection: ReturnType<typeof createInspection>,
) {
  async function read(
    ctx: restate.ObjectContext | restate.ObjectSharedContext,
  ) {
    const state = await ctx.get<CafeRun>('xstate');
    if (!state)
      throw new restate.TerminalError('Café does not exist', {
        errorCode: 404,
      });
    return state;
  }

  function schedule(ctx: restate.ObjectContext, state: CafeRun, now: number) {
    ctx.set('xstate', state);
    if (state.nextAt !== null)
      ctx
        .objectSendClient<{
          wake: (ctx: restate.ObjectContext, revision: number) => Promise<void>;
        }>({ name: 'Cafe' }, ctx.key)
        .wake(
          state.deliveries.length,
          restate.rpc.sendOpts({ delay: Math.max(0, state.nextAt - now) }),
        );
  }

  return restate.object({
    name: 'Cafe',
    handlers: {
      async start(ctx: restate.ObjectContext, input: unknown) {
        if (await ctx.get<CafeRun>('xstate')) return;
        const config = runConfigSchema.parse(input);
        const now = await ctx.date.now();
        schedule(
          ctx,
          await ctx.run('initialize XState', () =>
            startCafe(ctx.key, config, now, pay),
          ),
          now,
        );
      },
      async command(ctx: restate.ObjectContext, input: unknown) {
        const state = await read(ctx);
        const message = messageSchema.parse(input);
        if (Object.hasOwn(state.accepted, message.requestId)) return;
        const now = await ctx.date.now();
        schedule(
          ctx,
          await ctx.run('deliver XState command', () =>
            advanceCafe(state, now, pay, { ...message, acceptedAt: now }),
          ),
          now,
        );
      },
      async wake(ctx: restate.ObjectContext, revision: number) {
        const state = await read(ctx);
        if (state.deliveries.length !== revision || state.nextAt === null)
          return;
        const now = await ctx.date.now();
        schedule(
          ctx,
          await ctx.run('fire XState timer', () =>
            advanceCafe(state, now, pay),
          ),
          now,
        );
      },
      snapshot: restate.handlers.object.shared(
        async (ctx: restate.ObjectSharedContext) => {
          const state = await read(ctx);
          if (!state.config.inspect) return state.snapshot;
          const inspectorUrl = await ctx.run('inspect XState actor tree', () =>
            inspection.publish(state),
          );
          return { ...state.snapshot, inspectorUrl };
        },
      ),
    },
  });
}
