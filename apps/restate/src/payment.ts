import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as restate from '@restatedev/restate-sdk';
import { z } from 'zod';

const paymentSchema = z.object({
  orderId: z.string(),
  kind: z.enum(['charge', 'refund']),
});
type Payment = z.infer<typeof paymentSchema>;
type PaymentRequest = Payment & { cafeId: string; amount: number };

export function paymentProvider(
  path: string,
  afterCommit?: (payment: Payment) => void,
) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS payments (
      cafe_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      amount INTEGER NOT NULL,
      PRIMARY KEY (cafe_id, order_id, kind)
    );
  `);
  const read = db.prepare(
    'SELECT amount FROM payments WHERE cafe_id=? AND order_id=? AND kind=?',
  );
  const insert = db.prepare('INSERT INTO payments VALUES (?, ?, ?, ?)');

  return {
    pay(request: PaymentRequest): Payment {
      const { cafeId, orderId, kind, amount } = request;
      let created = false;
      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = read.get(cafeId, orderId, kind);
        if (existing && existing.amount !== amount) {
          throw new restate.TerminalError('Conflicting payment amount');
        }
        if (!existing) {
          if (
            kind === 'refund' &&
            read.get(cafeId, orderId, 'charge')?.amount !== amount
          ) {
            throw new restate.TerminalError(
              'Refund requires a matching charge',
            );
          }
          insert.run(cafeId, orderId, kind, amount);
          created = true;
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      const payment = { orderId, kind };
      if (created) afterCommit?.(payment);
      return payment;
    },
    list(cafeId: string): Payment[] {
      return z
        .array(paymentSchema)
        .parse(
          db
            .prepare(
              'SELECT order_id AS orderId, kind FROM payments WHERE cafe_id=? ORDER BY rowid',
            )
            .all(cafeId),
        );
    },
    close() {
      db.close();
    },
  };
}

export function createPayments(provider: ReturnType<typeof paymentProvider>) {
  return restate.service({
    name: 'Payments',
    handlers: {
      pay: (ctx: restate.Context, request: PaymentRequest) =>
        ctx.run(request.kind, () => provider.pay(request)),
      list: (ctx: restate.Context, cafeId: string) =>
        ctx.run('read receipts', () => provider.list(cafeId)),
    },
  });
}
