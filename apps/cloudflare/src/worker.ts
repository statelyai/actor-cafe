import { DurableObject } from 'cloudflare:workers';
import type { Command, RunConfig } from '@actor-cafe/contract';
import { cafeHttp } from '@actor-cafe/cafe/http';
import {
  advanceCafe,
  startCafe,
  type CafeRun,
  type PaymentOutcome,
  type PaymentRequest,
} from '@actor-cafe/cafe/turn';

interface Env {
  CAFE: DurableObjectNamespace<Cafe>;
  PAYMENTS: DurableObjectNamespace<Payments>;
  CAFE_FAULT?: string;
}

export class Payments extends DurableObject<Env> {
  async pay({
    orderId,
    kind,
    amount,
  }: PaymentRequest): Promise<PaymentOutcome> {
    return this.ctx.storage.transaction(async (tx) => {
      const key = `${orderId}:${kind}`;
      const existing = await tx.get<number>(key);
      if (existing !== undefined && existing !== amount)
        return { declined: 'Conflicting payment amount' };
      if (
        kind === 'refund' &&
        (await tx.get<number>(`${orderId}:charge`)) !== amount
      )
        return { declined: 'Refund requires a matching charge' };
      if (existing === undefined) {
        await tx.put(key, amount);
        if (kind === 'charge' && this.env.CAFE_FAULT === '1')
          await tx.put('last-charge', orderId);
      }
      return { receiptId: `${kind}:${orderId}` };
    });
  }

  async fixtureCharge() {
    return (await this.ctx.storage.get<string>('last-charge')) ?? null;
  }
}

export class Cafe extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      const state = await ctx.storage.get<CafeRun>('xstate');
      const alarm = await ctx.storage.getAlarm();
      if (state?.nextAt != null && (alarm === null || alarm < Date.now()))
        await ctx.storage.setAlarm(Math.max(Date.now() + 1, state.nextAt));
    });
  }

  private pay = async (request: PaymentRequest) => {
    const receipt = await this.env.PAYMENTS.getByName(request.cafeId).pay(
      request,
    );
    if (
      'receiptId' in receipt &&
      request.kind === 'charge' &&
      this.env.CAFE_FAULT === '1'
    )
      await new Promise(() => {});
    return receipt;
  };

  private async read() {
    const state = await this.ctx.storage.get<CafeRun>('xstate');
    if (!state) throw new Error('Café does not exist');
    return state;
  }

  private save(state: CafeRun) {
    return this.ctx.storage.transaction(async (tx) => {
      await tx.put('xstate', state);
      if (state.nextAt === null) await tx.deleteAlarm();
      else await tx.setAlarm(state.nextAt);
    });
  }

  start(id: string, config: RunConfig) {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (await this.ctx.storage.get('xstate')) return;
      await this.save(await startCafe(id, config, Date.now(), this.pay));
    });
  }

  command(requestId: string, command: Command) {
    const acceptedAt = Date.now();
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.save(
        await advanceCafe(await this.read(), Date.now(), this.pay, {
          requestId,
          command,
          acceptedAt,
        }),
      );
    });
  }

  alarm() {
    return this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.read();
      // Leave a durable wake in place until the new journal commits.
      await this.ctx.storage.setAlarm(Date.now() + 5_000);
      await this.ctx.storage.sync();
      await this.save(await advanceCafe(state, Date.now(), this.pay));
    });
  }

  async snapshot() {
    const state = await this.read();
    if (state.nextAt === null || state.nextAt + 1_000 > Date.now())
      return state.snapshot;
    return this.ctx.blockConcurrencyWhile(async () => {
      const current = await this.read();
      if (current.nextAt === null || current.nextAt + 1_000 > Date.now())
        return current.snapshot;
      const recovered = await advanceCafe(current, Date.now(), this.pay);
      await this.save(recovered);
      return recovered.snapshot;
    });
  }

  async journal() {
    const state = await this.read();
    return state.config.inspect ? state : null;
  }
}

export default {
  async fetch(request: Request, env: Env) {
    if (new URL(request.url).pathname === '/healthz')
      return new Response(null, { status: 204 });
    const fixture = /^\/fixture\/([a-f0-9-]{36})\/charge$/.exec(
      new URL(request.url).pathname,
    );
    if (env.CAFE_FAULT === '1' && fixture)
      return Response.json(
        await env.PAYMENTS.getByName(fixture[1]).fixtureCharge(),
      );
    return cafeHttp(request, {
      start: (id, config) => env.CAFE.getByName(id).start(id, config),
      command: (id, requestId, command) =>
        env.CAFE.getByName(id).command(requestId, command),
      snapshot: (id) => env.CAFE.getByName(id).snapshot(),
      journal: (id) => env.CAFE.getByName(id).journal(),
    });
  },
};
