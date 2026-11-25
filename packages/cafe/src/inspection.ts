import { setTimeout as delay } from 'node:timers/promises';
import { createInspector } from '@statelyai/sdk/inspect';
import { serializable } from '@demo/xstate-durable';
import { restoreCafe, type CafeRun } from './turn.ts';

export function createInspection(runtime: string) {
  const sessions = new Map<
    string,
    {
      inspector: ReturnType<typeof createInspector>;
      revision: number;
      link?: Promise<string | null>;
      retryAt: number;
    }
  >();

  return {
    async publish(state: CafeRun) {
      let session = sessions.get(state.id);
      if (!session) {
        const inspector = createInspector({
          name: `${runtime} · XState café`,
          roomId: state.id,
          producerId: state.id,
          launch: 'none',
          bidirectional: false,
          serializeSnapshot: (snapshot) =>
            serializable({
              value: snapshot.value,
              status: snapshot.status,
              context: snapshot.context,
              tags: snapshot.tags ? [...snapshot.tags] : [],
            }),
        });
        void inspector.ready.catch(() => {});
        session = {
          inspector,
          revision: -1,
          retryAt: 0,
        };
        sessions.set(state.id, session);
      }
      const revision = state.deliveries.length;
      if (session.revision < revision) {
        const execution = await restoreCafe(state);
        if (session.revision < revision) {
          execution.resumeInspection(session.inspector);
          session.revision = revision;
        }
      }
      if (!session.link && Date.now() >= session.retryAt) {
        const current = session;
        current.link = current.inspector.createViewerLink({ maxUses: 100 }).then(
          ({ openUrl }) => openUrl,
          () => {
            current.link = undefined;
            current.retryAt = Date.now() + 3_000;
            return null;
          },
        );
      }
      if (!session.link) return null;
      return Promise.race([session.link, delay(2_000, null, { ref: false })]);
    },
    destroy() {
      for (const { inspector } of sessions.values()) inspector.destroy();
      sessions.clear();
    },
  };
}
