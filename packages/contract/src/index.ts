import { z } from 'zod';

export const runtimeSchema = z.enum(['rivet', 'restate']);
export const drinkSchema = z.enum(['espresso', 'latte']);
export const runConfigSchema = z.object({
  customers: z.number().int().min(0).max(100),
  baristas: z.number().int().min(1).max(20),
  tickMs: z.number().int().min(20).max(5_000),
  inspect: z.boolean(),
});
export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('arrival'), drink: drinkSchema }),
  z.object({ type: z.literal('cancel'), orderId: z.string().min(1) }),
  z.object({ type: z.literal('close') }),
]);
export const cafeSnapshotSchema = z.object({
  status: z.enum(['open', 'closing', 'closed']),
  orders: z.array(
    z.object({
      id: z.string(),
      drink: drinkSchema,
      status: z.enum([
        'paying',
        'queued',
        'preparing',
        'served',
        'cancelled',
        'failed',
      ]),
      paid: z.boolean(),
      refunded: z.boolean(),
    }),
  ),
  actors: z.array(
    z.object({
      id: z.string(),
      kind: z.enum([
        'cafe',
        'customer',
        'barista',
        'equipment',
        'order',
        'payment',
      ]),
      state: z.string(),
    }),
  ),
  grinder: z.object({
    holder: z.string().nullable(),
    queued: z.array(z.string()),
  }),
  payments: z.array(
    z.object({ orderId: z.string(), kind: z.enum(['charge', 'refund']) }),
  ),
  inspectorUrl: z.url().nullable(),
});

export type Runtime = z.infer<typeof runtimeSchema>;
export type RunConfig = z.infer<typeof runConfigSchema>;
export type Command = z.infer<typeof commandSchema>;
export type CafeSnapshot = z.infer<typeof cafeSnapshotSchema>;
export interface CafeBackend {
  start(id: string, config: RunConfig): Promise<void>;
  command(id: string, requestId: string, command: Command): Promise<void>;
  snapshot(id: string): Promise<CafeSnapshot>;
}
