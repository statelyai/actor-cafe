import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import {
  cafeSnapshotSchema,
  commandSchema,
  runConfigSchema,
  runtimeSchema,
  type CafeBackend,
  type Runtime,
} from '@actor-cafe/contract';
import { z } from 'zod';
import { createHttpBackend } from '@actor-cafe/cafe/http';
import { createInspection } from '@actor-cafe/cafe/inspection';
import { createRivetBackend } from '../apps/rivet/src/rivet/backend.ts';
import { createRestateBackend } from '../apps/restate/src/backend.ts';

const commandRequest = z.object({
  requestId: z.string().min(1).max(200),
  command: commandSchema,
});
const runId = z.uuid();
const rivet = createRivetBackend(
  process.env.RIVET_CAFE_ENDPOINT ?? 'http://127.0.0.1:6480',
);
const backends: Partial<Record<Runtime, CafeBackend>> = { rivet };
if (process.env.RESTATE_CAFE_INGRESS)
  backends.restate = createRestateBackend(process.env.RESTATE_CAFE_INGRESS);

const extraEndpoints = {
  cloudflare: process.env.CLOUDFLARE_CAFE_URL,
  temporal: process.env.TEMPORAL_CAFE_URL,
  workflow: process.env.WORKFLOW_CAFE_URL,
} satisfies Partial<Record<Runtime, string | undefined>>;
const inspections: ReturnType<typeof createInspection>[] = [];
for (const runtime of Object.keys(
  extraEndpoints,
) as (keyof typeof extraEndpoints)[]) {
  const endpoint = extraEndpoints[runtime];
  if (!endpoint) continue;
  const backend = createHttpBackend(endpoint);
  const inspector = createInspection(runtime);
  inspections.push(inspector);
  backends[runtime] = {
    ...backend,
    async snapshot(id) {
      const snapshot = await backend.snapshot(id);
      const state = await backend.journal(id);
      if (!state) return snapshot;
      const inspectorUrl = await inspector.publish(state);
      return { ...state.snapshot, inspectorUrl };
    },
  };
}

async function body(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json')
    throw new SyntaxError('Expected an application/json request.');
  let bytes = 0;
  let data = '';
  req.setEncoding('utf8');
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 8_192) throw new SyntaxError('Request body is too large.');
    data += chunk;
  }
  return JSON.parse(data);
}

function json(response: ServerResponse, status: number, data: unknown) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  const url = URL.parse(req.url ?? '/', 'http://localhost');
  if (!url) return json(res, 400, { error: 'Invalid request URL.' });
  const { pathname } = url;
  const [, api, runtime, runs, id, commands, ...rest] = pathname.split('/');
  if (
    api === 'api' &&
    runtime === 'runtimes' &&
    runs === undefined &&
    req.method === 'GET'
  )
    return json(res, 200, { runtimes: Object.keys(backends) });

  const parsedRuntime = runtimeSchema.safeParse(runtime);
  if (
    api !== 'api' ||
    !parsedRuntime.success ||
    runs !== 'runs' ||
    rest.length > 0
  )
    return json(res, 404, { error: 'Route not found.' });
  const backend = backends[parsedRuntime.data];
  if (!backend)
    return json(res, 503, { error: 'This runtime is unavailable.' });
  try {
    if (req.method === 'POST' && id === undefined) {
      const config = runConfigSchema.parse(await body(req));
      const id = randomUUID();
      await backend.start(id, config);
      return json(res, 201, { id });
    }
    const key = runId.parse(id);
    if (req.method === 'GET' && commands === undefined)
      return json(
        res,
        200,
        cafeSnapshotSchema.parse(await backend.snapshot(key)),
      );
    if (req.method === 'POST' && commands === 'commands') {
      const { requestId, command } = commandRequest.parse(await body(req));
      await backend.command(key, requestId, command);
      return json(res, 202, { accepted: true });
    }
    return json(res, 404, { error: 'Route not found.' });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return json(res, 400, {
        error: 'Invalid request. Check the run settings or command.',
      });
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Café ${req.method} ${pathname}: ${message}`);
    return json(res, 502, { error: message });
  }
});

server.listen(4200, '127.0.0.1', () =>
  console.log('Café API at http://127.0.0.1:4200'),
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    server.close();
    void rivet.dispose();
    for (const inspector of inspections) inspector.destroy();
  });
