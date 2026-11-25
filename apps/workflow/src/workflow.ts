import { createHook, sleep } from 'workflow';
import type { RunConfig } from '@actor-cafe/contract';
import {
  advanceCafe,
  startCafe,
  type CafeMessage,
  type CafeRun,
} from '@actor-cafe/cafe/turn';
import { pay, writeRun } from './storage.ts';

async function initialize(id: string, config: RunConfig, now: number) {
  'use step';
  const state = await startCafe(id, config, now, pay);
  writeRun(id, state);
  return state;
}

async function advance(state: CafeRun, now: number, message?: CafeMessage) {
  'use step';
  const next = await advanceCafe(state, now, pay, message);
  writeRun(next.id, next);
  return next;
}

export async function cafeWorkflow(id: string, config: RunConfig) {
  'use workflow';
  const hook = createHook<CafeMessage>({ token: id });
  const iterator = hook[Symbol.asyncIterator]();
  let pending = iterator.next();
  try {
    let state = await initialize(id, config, Date.now());
    while (state.snapshot.status !== 'closed') {
      const event =
        state.nextAt === null
          ? await pending
          : state.nextAt <= Date.now()
            ? null
            : await Promise.race([
                pending,
                sleep(new Date(state.nextAt)).then(() => null),
              ]);
      if (event?.done) throw new Error('Café hook ended early.');
      state = await advance(state, Date.now(), event?.value);
      if (event) pending = iterator.next();
    }
    return state.snapshot;
  } finally {
    hook.dispose();
  }
}
