import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CafeRun, PaymentRequest } from '@actor-cafe/cafe/turn';
import { paymentProvider } from '@actor-cafe/cafe/payment-db';
import { cafeRunSchema } from '@actor-cafe/cafe/http';

const path = process.env.CAFE_PAYMENT_DB ?? '.cafe/workflow.sqlite';
let database: DatabaseSync | undefined;
let ledger: ReturnType<typeof paymentProvider> | undefined;
function db() {
  if (!database) {
    mkdirSync(dirname(path), { recursive: true });
    database = new DatabaseSync(path);
    database.exec(
      'PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS views (id TEXT PRIMARY KEY, state TEXT NOT NULL)',
    );
  }
  return database;
}

export function writeRun(id: string, run: CafeRun) {
  db()
    .prepare(
      'INSERT INTO views VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET state=excluded.state',
    )
    .run(id, JSON.stringify(run));
}

function readView(id: string) {
  const row = db().prepare('SELECT state FROM views WHERE id = ?').get(id);
  if (typeof row?.state !== 'string')
    throw new Error('Workflow café is initializing.');
  return cafeRunSchema.parse(JSON.parse(row.state));
}

export function readSnapshot(id: string) {
  return readView(id).snapshot;
}

export function readJournal(id: string) {
  const run = readView(id);
  return run.config.inspect ? run : null;
}

export async function pay(request: PaymentRequest) {
  ledger ??= paymentProvider(path);
  const receipt = await ledger.pay(request);
  if (request.kind === 'charge' && process.env.CAFE_CRASH_AFTER_CHARGE === '1')
    await new Promise(() => {});
  return receipt;
}
