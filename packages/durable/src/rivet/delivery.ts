import type { Delivery } from './execution.ts';

export function selectDelivery(
  timer: Delivery | undefined,
  pending: Delivery | undefined,
  now: number,
): 'timer' | 'message' | 'none' {
  // The native queue timestamp establishes how far time has advanced.
  if (pending) return timer && timer.at <= pending.at ? 'timer' : 'message';
  return timer && timer.at <= now ? 'timer' : 'none';
}
