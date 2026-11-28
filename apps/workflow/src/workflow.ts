import { createHook, getStepMetadata, sleep } from 'workflow';
import type { RunConfig } from '@actor-cafe/contract';
import {
  advanceCafe,
  startCafe,
  type CafeMessage,
  type CafeRun,
} from '@actor-cafe/cafe/turn';
import { initializeRun, pay, writeRun } from './storage.ts';

async function initialize(id: string, config: RunConfig, now: number) {
  'use step';
  const state = await startCafe(id, config, now, pay);
  return initializeRun(state, getStepMetadata().stepId);
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
  let buffered: IteratorResult<CafeMessage> | undefined;
  const readNext = () =>
    iterator.next().then((event) => {
      buffered = event;
      return event;
    });
  let pending = readNext();
  try {
    let state = await initialize(id, config, Date.now());
    if (!state) return;
    while (state.snapshot.status !== 'closed') {
      const event =
        buffered ??
        (state.nextAt === null
          ? await pending
          : state.nextAt <= Date.now()
            ? null
            : await Promise.race([
                pending,
                sleep(new Date(state.nextAt)).then(() => null),
              ]));
      if (event?.done) throw new Error('Café hook ended early.');
      state = await advance(state, Date.now(), event?.value);
      if (event) {
        buffered = undefined;
        pending = readNext();
      }
    }
    return state.snapshot;
  } finally {
    hook.dispose();
  }
}
