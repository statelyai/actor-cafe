import {
  advanceCafe,
  startCafe,
  type CafeMessage,
  type CafeRun,
  type Pay,
} from '@actor-cafe/cafe/turn';
import type { RunConfig } from '@actor-cafe/contract';

export function cafeActivities(pay: Pay) {
  return {
    initialize: (id: string, config: RunConfig, now: number) =>
      startCafe(id, config, now, pay),
    advance: (state: CafeRun, now: number, message?: CafeMessage) =>
      advanceCafe(state, now, pay, message),
  };
}
