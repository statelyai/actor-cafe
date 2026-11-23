import { createInspector, type Inspector } from '@statelyai/sdk/inspect';
import type { CafeSnapshot } from '@actor-cafe/contract';

type Actor = CafeSnapshot['actors'][number];
const machines = {
  cafe: { open: ['closing', 'closed'], closing: ['closed'], closed: [] },
  equipment: { available: ['reserved'], reserved: ['available'] },
  customer: { waiting: ['served', 'left'], served: [], left: [] },
  order: {
    paying: ['queued', 'preparing', 'cancelled', 'failed'],
    queued: ['preparing', 'cancelled'],
    preparing: ['served', 'cancelled', 'failed'],
    served: [],
    cancelled: [],
    failed: [],
  },
  payment: {
    waiting: ['charging', 'charged', 'cancelled'],
    charging: ['charged', 'cancelled'],
    charged: ['refunded'],
    refunded: [],
    cancelled: [],
  },
  barista: {
    idle: ['waiting-grinder', 'grinding'],
    'waiting-grinder': ['grinding', 'idle'],
    grinding: ['waiting-espresso', 'extracting', 'idle'],
    'waiting-espresso': ['extracting', 'idle'],
    extracting: ['waiting-frother', 'frothing', 'handoff', 'idle'],
    'waiting-frother': ['frothing', 'idle'],
    frothing: ['handoff', 'idle'],
    handoff: ['idle', 'waiting-grinder', 'grinding'],
  },
} satisfies Record<Actor['kind'], Record<string, string[]>>;

function graph(kind: Actor['kind']) {
  const entries = Object.entries(machines[kind]);
  return {
    id: kind,
    initial: entries[0]?.[0],
    states: Object.fromEntries(
      entries.map(([state, targets]) => [
        state,
        {
          on: Object.fromEntries(
            targets.map((target) => [`to.${target}`, target]),
          ),
        },
      ]),
    ),
  };
}

export function createInspection() {
  const rooms = new Map<
    string,
    { inspector: Inspector; states: Map<string, string>; revision: number }
  >();
  return {
    publish(roomId: string, revision: number, actors: Actor[]) {
      let room = rooms.get(roomId);
      if (!room) {
        const inspector = createInspector({
          name: 'Restate café (actor projection)',
          roomId,
          producerId: roomId,
          launch: 'none',
          bidirectional: false,
        });
        void inspector.ready.catch((error: unknown) => {
          console.warn('Could not connect to Stately Inspector:', error);
        });
        room = { inspector, states: new Map(), revision: -1 };
        rooms.set(roomId, room);
      }
      if (revision < room.revision) return room.inspector.inspectorUrl;
      room.revision = revision;
      for (const actor of actors) {
        const previous = room.states.get(actor.id);
        if (previous === actor.state) continue;
        const snapshot = {
          status: 'active',
          value: actor.state,
          context: { id: actor.id, kind: actor.kind },
        };
        if (previous === undefined)
          room.inspector.actor(actor.id, {
            parent:
              actor.kind === 'cafe'
                ? undefined
                : actor.kind === 'payment'
                ? actor.id.slice('payment-'.length)
                : 'cafe',
            machine: graph(actor.kind),
            snapshot,
          });
        else
          room.inspector.snapshot(actor.id, snapshot, {
            type: `to.${actor.state}`,
          });
        room.states.set(actor.id, actor.state);
      }
      return room.inspector.inspectorUrl;
    },
    destroy() {
      for (const room of rooms.values()) room.inspector.destroy();
      rooms.clear();
    },
  };
}
