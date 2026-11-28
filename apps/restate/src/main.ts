import { createServer, type ServerHttp2Session } from 'node:http2';
import * as restate from '@restatedev/restate-sdk';
import { z } from 'zod';
import { createCafeService } from './cafe.ts';
import { createInspection } from '@actor-cafe/cafe/inspection';
import { paymentProvider } from '@actor-cafe/cafe/payment-db';

const port = z.coerce
  .number()
  .int()
  .min(1)
  .max(65535)
  .parse(process.env.RESTATE_SERVICE_PORT ?? 9080);
const paymentDb =
  process.env.RESTATE_PAYMENT_DB ?? '.cafe/restate-payments.sqlite';
const provider = paymentProvider(paymentDb, (payment) => {
  if (
    process.send &&
    process.env.CAFE_CRASH_AFTER_CHARGE === '1' &&
    payment.kind === 'charge'
  ) {
    process.send({ type: 'fault.payment', data: payment });
    process.kill(process.pid, 'SIGSTOP');
  }
});
const inspection = createInspection('Restate');
const server = createServer(
  restate.createEndpointHandler({
    services: [
      createCafeService((request) => provider.pay(request), inspection),
    ],
  }),
);

const sessions = new Set<ServerHttp2Session>();
let stopping = false;
server.on('session', (session) => {
  sessions.add(session);
  session.once('close', () => sessions.delete(session));
  if (stopping) session.close();
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(
    `Restate café service listening at http://127.0.0.1:${port}\n`,
  );
  process.send?.({ type: 'ready' });
});
function shutdown() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => {
    for (const session of sessions) session.destroy();
  }, 2000).unref();
  server.close(() => {
    clearTimeout(deadline);
    inspection.destroy();
    provider.close();
  });
  for (const session of sessions) session.close();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
