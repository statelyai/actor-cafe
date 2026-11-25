import { setTimeout as delay } from 'node:timers/promises';
import type { CafeBackend, CafeSnapshot } from '@actor-cafe/contract';
import { createClient } from 'rivetkit/client';
import { projectCafe } from '@actor-cafe/cafe/projection';
import { createCafeRegistry } from './registry.ts';
import { retryIdempotentRivetRequest as retry } from './requests.ts';

export function createRivetBackend(
  endpoint: string,
): CafeBackend & { dispose(): Promise<void> } {
  const client = createClient<ReturnType<typeof createCafeRegistry>>(endpoint);

  async function snapshot(id: string): Promise<CafeSnapshot> {
    const cafe = client.cafe.get([id]);
    const view = await retry(() => cafe.getSnapshot());
    if (!view)
      throw new Error('The café has not published its first snapshot.');
    const { executionId } = await retry(() => cafe.info());
    const ledger = client.payments.getOrCreate([executionId]);
    const payments = await retry(() => ledger.receipts());
    return projectCafe(
      view,
      payments.map(({ orderId, kind }) => ({ orderId, kind })),
      view.inspectorUrl,
    );
  }

  return {
    async start(id, { inspect, ...config }) {
      const cafe = client.cafe.getOrCreate([id], {
        createWithInput: { config, inspect },
      });
      await retry(() => cafe.info());
      const deadline = Date.now() + 20_000;
      while (!(await retry(() => cafe.getSnapshot()))) {
        if (Date.now() >= deadline)
          throw new Error('The café did not publish its initial snapshot.');
        await delay(50);
      }
    },
    async command(id, requestId, command) {
      await retry(() => client.cafe.get([id]).dispatch(command, requestId));
    },
    snapshot,
    dispose: () => client.dispose(),
  };
}
