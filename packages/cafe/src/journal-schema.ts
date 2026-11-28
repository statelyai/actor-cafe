import {
  cafeSnapshotSchema,
  commandSchema,
  runConfigSchema,
} from '@actor-cafe/contract';
import type { CafeRun } from './turn.ts';
import { z } from 'zod';

export const messageSchema = z.object({
  requestId: z.string().min(1),
  command: commandSchema,
});

const delivery = z.object({
  address: z.string(),
  at: z.number(),
  event: z.object({ type: z.string() }).passthrough(),
  commandId: z.string().nullable(),
});
const result = z.discriminatedUnion('status', [
  z.object({ status: z.literal('done'), value: z.json() }),
  z.object({
    status: z.literal('error'),
    name: z.string(),
    message: z.string(),
  }),
]);
export const cafeRunSchema = z.object({
  id: z.string(),
  config: runConfigSchema,
  startedAt: z.number(),
  deliveries: z.array(delivery),
  results: z.record(z.string(), result),
  receipts: cafeSnapshotSchema.shape.payments,
  inbox: z.array(messageSchema.extend({ acceptedAt: z.number() })),
  accepted: z.record(z.string(), z.enum(['arrival', 'cancel', 'close'])),
  nextAt: z.number().nullable(),
  snapshot: cafeSnapshotSchema,
}) satisfies z.ZodType<CafeRun>;
