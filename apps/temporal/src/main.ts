import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
} from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { paymentProvider } from '@actor-cafe/cafe/payment-db';
import { cafeHttp } from '@actor-cafe/cafe/http';
import { cafeActivities } from './activities.ts';
import { cafe, deliver, journal, snapshot } from './workflow.ts';

const address = process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
const taskQueue = 'actor-cafe';
const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';
const paymentDb = paymentProvider(
  process.env.CAFE_PAYMENT_DB ?? '.cafe/temporal.sqlite',
);
const native = await NativeConnection.connect({ address });
const connection = await Connection.connect({ address });
const client = new Client({ connection, namespace });
const worker = await Worker.create({
  connection: native,
  namespace,
  taskQueue,
  workflowsPath: fileURLToPath(new URL('./workflow.ts', import.meta.url)),
  activities: cafeActivities(async (request) => {
    const receipt = await paymentDb.pay(request);
    if (
      process.env.CAFE_CRASH_AFTER_CHARGE === '1' &&
      'receiptId' in receipt &&
      request.kind === 'charge'
    )
      await new Promise(() => {});
    return receipt;
  }),
});

const backend: Parameters<typeof cafeHttp>[1] = {
  async start(id, config) {
    try {
      await client.workflow.start(cafe, {
        workflowId: id,
        workflowIdReusePolicy: 'REJECT_DUPLICATE',
        taskQueue,
        args: [id, config],
      });
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
    }
    const handle = client.workflow.getHandle(id);
    for (let i = 0; i < 150; i++) {
      if (await handle.query(snapshot)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Temporal café did not initialize.');
  },
  async command(id, requestId, command) {
    await client.workflow
      .getHandle(id)
      .signal(deliver, { requestId, command, acceptedAt: Date.now() });
  },
  journal: (id) => client.workflow.getHandle(id).query(journal),
  async snapshot(id) {
    const handle = client.workflow.getHandle(id);
    const state = await handle.query(snapshot);
    if (!state) throw new Error('Temporal café is initializing.');
    return state;
  },
};

const server = createServer(async (incoming, outgoing) => {
  const chunks = [];
  for await (const chunk of incoming) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const request = new Request(`http://127.0.0.1${incoming.url ?? '/'}`, {
    method: incoming.method,
    headers: new Headers(incoming.headers as Record<string, string>),
    body: body.length ? new Uint8Array(body) : undefined,
  });
  const response = await cafeHttp(request, backend);
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(await response.text());
});
server.listen(Number(process.env.CAFE_HTTP_PORT ?? 4301), '127.0.0.1', () => {
  console.log('Temporal café API is ready');
  process.send?.({ type: 'ready' });
});
try {
  await worker.run();
} finally {
  server.close();
  paymentDb.close();
  await Promise.all([connection.close(), native.close()]);
}
