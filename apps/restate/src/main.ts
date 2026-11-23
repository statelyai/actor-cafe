import { createServer } from 'node:http2';
import * as restate from '@restatedev/restate-sdk';
import { z } from 'zod';
import { createCafeService } from './cafe.ts';
import { createInspection } from './inspection.ts';
import { createPayments, paymentProvider } from './payment.ts';

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
const payments = createPayments(provider);
const inspection = createInspection();
const server = createServer(
  restate.createEndpointHandler({
    services: [createCafeService(payments, inspection), payments],
  }),
);

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(
    `Restate café service listening at http://127.0.0.1:${port}\n`,
  );
  process.send?.({ type: 'ready' });
});
function shutdown() {
  inspection.destroy();
  server.close(() => provider.close());
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
