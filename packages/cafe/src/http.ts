import {
  cafeSnapshotSchema,
  runConfigSchema,
  type CafeBackend,
} from '@actor-cafe/contract';
import { z } from 'zod';

import type { CafeRun } from './turn.ts';
import { cafeRunSchema, messageSchema } from './journal-schema.ts';
export { cafeRunSchema, messageSchema } from './journal-schema.ts';

type CafeHttpBackend = CafeBackend & {
  journal(id: string): Promise<CafeRun | null>;
};

export function createHttpBackend(endpoint: string): CafeHttpBackend {
  async function invoke(id: string, handler: string, body?: unknown) {
    const response = await fetch(
      new URL(
        `api/runs/${encodeURIComponent(id)}/${handler}`,
        endpoint.endsWith('/') ? endpoint : endpoint + '/',
      ),
      body === undefined
        ? undefined
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
    );
    if (!response.ok)
      throw new Error(
        `Café ${handler} failed (${response.status}): ${await response.text()}`,
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
    async journal(id) {
      return cafeRunSchema
        .nullable()
        .parse(await (await invoke(id, 'journal')).json());
    },
  };
}

export async function cafeHttp(
  request: Request,
  backend: CafeHttpBackend,
): Promise<Response> {
  const [, api, runs, id, operation, extra] = new URL(
    request.url,
  ).pathname.split('/');
  if (
    api !== 'api' ||
    runs !== 'runs' ||
    !z.uuid().safeParse(id).success ||
    extra
  )
    return new Response('Unknown café route', { status: 404 });
  try {
    if (request.method === 'GET' && operation === 'snapshot')
      return Response.json(await backend.snapshot(id));
    if (request.method === 'GET' && operation === 'journal')
      return Response.json(await backend.journal(id));
    if (request.method === 'POST' && operation === 'start') {
      await backend.start(id, runConfigSchema.parse(await request.json()));
      return new Response(null, { status: 201 });
    }
    if (request.method === 'POST' && operation === 'command') {
      const { requestId, command } = messageSchema.parse(await request.json());
      await backend.command(id, requestId, command);
      return new Response(null, { status: 202 });
    }
    return new Response('Unknown café operation', { status: 404 });
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : String(error),
      {
        status:
          error instanceof z.ZodError || error instanceof SyntaxError
            ? 400
            : 500,
      },
    );
  }
}
