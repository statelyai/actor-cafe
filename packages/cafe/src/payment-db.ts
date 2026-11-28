import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Payment, PaymentOutcome, PaymentRequest } from './turn.ts';

export function paymentProvider(
  path: string,
  afterCommit?: (payment: Payment) => void,
) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
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
    async pay(request: PaymentRequest): Promise<PaymentOutcome> {
      const { cafeId, orderId, kind, amount } = request;
      let created = false;
      let declined: string | undefined;
      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = read.get(cafeId, orderId, kind);
        if (existing && existing.amount !== amount) {
          declined = 'Conflicting payment amount';
        } else if (!existing) {
          if (
            kind === 'refund' &&
            read.get(cafeId, orderId, 'charge')?.amount !== amount
          ) {
            declined = 'Refund requires a matching charge';
          } else {
            insert.run(cafeId, orderId, kind, amount);
            created = true;
          }
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      if (declined) return { declined };
      const payment = { orderId, kind };
      if (created) afterCommit?.(payment);
      return { receiptId: `${kind}:${orderId}` };
    },
    close() {
      db.close();
    },
  };
}
