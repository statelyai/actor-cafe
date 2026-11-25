import {
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import type { CafeSnapshot, RunConfig } from '@actor-cafe/contract';
import type { CafeMessage, CafeRun } from '@actor-cafe/cafe/turn';
import type { cafeActivities } from './activities.ts';

const { initialize, advance } = proxyActivities<
  ReturnType<typeof cafeActivities>
>({
  startToCloseTimeout: '10 seconds',
});
export const deliver = defineSignal<[CafeMessage]>('deliver');
export const snapshot = defineQuery<CafeSnapshot | undefined>('snapshot');
export const journal = defineQuery<CafeRun | null>('journal');

export async function cafe(id: string, config: RunConfig) {
  const messages: CafeMessage[] = [];
  let view: CafeSnapshot | undefined;
  setHandler(deliver, (message) => {
    messages.push(message);
  });
  setHandler(snapshot, () => view);
  let state = await initialize(id, config, Date.now());
  view = state.snapshot;
  setHandler(journal, () => (config.inspect ? state : null));
  while (view.status !== 'closed') {
    if (state.nextAt === null) await condition(() => messages.length > 0);
    else if (state.nextAt > Date.now())
      await condition(() => messages.length > 0, state.nextAt - Date.now());
    state = await advance(state, Date.now(), messages.shift());
    view = state.snapshot;
  }
  return view;
}
