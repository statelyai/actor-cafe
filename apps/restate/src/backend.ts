import { cafeSnapshotSchema, type CafeBackend } from '@actor-cafe/contract';

export function createRestateBackend(ingress: string): CafeBackend {
  async function invoke(id: string, handler: string, body?: unknown) {
    const response = await fetch(
      new URL(
        `Cafe/${encodeURIComponent(id)}/${handler}`,
        ingress.endsWith('/') ? ingress : `${ingress}/`,
      ),
      {
        method: 'POST',
        ...(body === undefined
          ? {}
          : {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }),
      },
    );
    if (!response.ok)
      throw new Error(
        `Restate ${handler} failed (${
          response.status
        }): ${await response.text()}`,
      );
    return response;
  }

  return {
    async start(id, config) {
      await invoke(id, 'start', config);
    },
    async command(id, requestId, command) {
      await invoke(id, 'command', { requestId, command });
    },
    async snapshot(id) {
      return cafeSnapshotSchema.parse(
        await (await invoke(id, 'snapshot')).json(),
      );
    },
  };
}
