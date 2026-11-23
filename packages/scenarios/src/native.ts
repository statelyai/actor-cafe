import { fork, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { CafeBackend, Runtime } from '@actor-cafe/contract';
import { z } from 'zod';
import { createRivetBackend } from '../../../apps/rivet/src/rivet/backend.ts';
import { createRestateBackend } from '../../../apps/restate/src/backend.ts';

const loopback = '127.0.0.1';
const addr = (port: number) => `${loopback}:${port}`;
const url = (port: number) => `http://${addr(port)}`;
const packetSchema = z.object({
  type: z.string(),
  data: z.unknown().optional(),
  enginePid: z.number().int().positive().nullish(),
});

async function reserve(port: number) {
  const server = createServer();
  server.listen(port, loopback);
  await once(server, 'listening');
  return server;
}

async function freePorts(offsets: number[]): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const probe = await reserve(0);
    const address = probe.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected a TCP address');
    const servers = [probe];
    try {
      for (const offset of offsets)
        servers.push(await reserve(address.port + offset));
      return address.port;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        (error.code !== 'EADDRINUSE' && error.code !== 'ERR_SOCKET_BAD_PORT')
      )
        throw error;
    } finally {
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        ),
      );
    }
  }
  throw new Error('Could not reserve consecutive fixture ports');
}

class NativeProcess {
  readonly messages = new Map<string, z.infer<typeof packetSchema>>();
  readonly enginePids = new Set<number>();
  readonly log: () => string;
  private error: Error | undefined;

  constructor(readonly child: ChildProcess) {
    let output = '';
    this.log = () => output;
    for (const stream of [child.stderr, child.stdout]) {
      stream?.on('data', (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-12_000);
      });
    }
    child.on('error', (error) => {
      this.error = error;
    });
    child.on('message', (message) => {
      const parsed = packetSchema.safeParse(message);
      if (!parsed.success) return;
      const packet = parsed.data;
      if (packet.enginePid) this.enginePids.add(packet.enginePid);
      this.messages.set(packet.type, packet);
    });
  }

  assertRunning() {
    if (this.error) throw this.error;
    if (this.child.exitCode !== null || this.child.signalCode !== null)
      throw new Error(
        `Fixture exited (${
          this.child.exitCode ?? this.child.signalCode
        })\n${this.log()}`,
      );
  }

  async wait(type: string) {
    const deadline = Date.now() + 50_000;
    while (Date.now() < deadline) {
      const message = this.messages.get(type);
      if (message) return message;
      this.assertRunning();
      await delay(25);
    }
    throw new Error(
      `Timed out waiting for fixture message ${type}\n${this.log()}`,
    );
  }

  async kill() {
    if (
      this.child.pid === undefined ||
      this.child.exitCode !== null ||
      this.child.signalCode !== null
    )
      return;
    const exited = once(this.child, 'exit');
    this.child.kill('SIGKILL');
    await exited;
  }
}

function forkWorker(path: URL, args: string[], env: NodeJS.ProcessEnv = {}) {
  return new NativeProcess(
    fork(fileURLToPath(path), args, {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, ...env },
    }),
  );
}

function signalEngine(pid: number, signal: NodeJS.Signals | 0) {
  try {
    return process.kill(pid, signal);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH')
      return false;
    throw error;
  }
}

async function stopEngine(pid: number) {
  if (!signalEngine(pid, 'SIGTERM')) return;
  const limit = Date.now() + 5_000;
  while (Date.now() < limit) {
    if (!signalEngine(pid, 0)) return;
    await delay(50);
  }
  signalEngine(pid, 'SIGKILL');
  const forcedLimit = Date.now() + 2_000;
  while (Date.now() < forcedLimit) {
    if (!signalEngine(pid, 0)) return;
    await delay(50);
  }
  throw new Error(`Fixture engine ${pid} did not exit`);
}

interface Fixture {
  backend: CafeBackend;
  crashAndRestart(runId: string): Promise<string>;
}

export async function nativeFixture(
  context: TestContext,
  runtime: Runtime,
  chargeFault: boolean,
): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), `actor-cafe-${runtime}-`));
  const processes: NativeProcess[] = [];
  let dispose: (() => Promise<void>) | undefined;
  context.after(async () => {
    try {
      await dispose?.();
    } finally {
      for (const process of processes) await process.kill();
      for (const pid of new Set(
        processes.flatMap((process) => [...process.enginePids]),
      ))
        await stopEngine(pid);
      await rm(directory, { recursive: true, force: true });
    }
  });

  if (runtime === 'rivet') {
    const port = await freePorts([1, 10]);
    const startWorker = async (fault: boolean) => {
      const worker = forkWorker(
        new URL(
          '../../../apps/rivet/src/fixtures/rivet-worker.ts',
          import.meta.url,
        ),
        [directory, String(port), fault ? 'payment' : 'normal'],
        { RIVET_LOG_LEVEL: 'error', RUST_LOG: 'error' },
      );
      processes.push(worker);
      await worker.wait('ready');
      return worker;
    };
    const worker = await startWorker(chargeFault);
    const backend = createRivetBackend(url(port));
    dispose = async () => {
      await backend.dispose?.();
    };
    return {
      backend,
      async crashAndRestart() {
        const fault = await worker.wait('fault.payment');
        const orderId = z.string().parse(fault.data);
        await worker.kill();
        await startWorker(false);
        return orderId;
      },
    };
  }

  const port = await freePorts([1, 2, 3]);
  const admin = url(port + 1);
  const ingress = url(port + 2);
  const servicePort = port + 3;
  const dbPath = join(directory, 'provider.sqlite');
  const configPath = join(directory, 'restate.toml');
  await writeFile(
    configPath,
    `bind-address = "${addr(port)}"
advertised-address = "${url(port)}/"
default-num-partitions = 1

[admin]
bind-address = "${addr(port + 1)}"
advertised-admin-endpoint = "${admin}/"

[ingress]
bind-address = "${addr(port + 2)}"
advertised-ingress-endpoint = "${ingress}/"
`,
  );
  const server = new NativeProcess(
    spawn(
      process.env.RESTATE_SERVER ?? 'restate-server',
      ['--config-file', configPath, '--base-dir', join(directory, 'journal')],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ),
  );
  processes.push(server);
  const startWorker = async (fault: boolean) => {
    const worker = forkWorker(
      new URL('../../../apps/restate/src/main.ts', import.meta.url),
      [],
      {
        RESTATE_SERVICE_PORT: String(servicePort),
        RESTATE_PAYMENT_DB: dbPath,
        CAFE_CRASH_AFTER_CHARGE: fault ? '1' : '0',
      },
    );
    processes.push(worker);
    await worker.wait('ready');
    return worker;
  };
  const worker = await startWorker(chargeFault);
  await deploy(server, admin, url(servicePort));

  return {
    backend: createRestateBackend(ingress),
    async crashAndRestart(runId) {
      const fault = await worker.wait('fault.payment');
      const { orderId } = z
        .object({
          kind: z.literal('charge'),
          orderId: z.string(),
        })
        .parse(fault.data);
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const rows = db
          .prepare('SELECT order_id, kind FROM payments WHERE cafe_id = ?')
          .all(runId);
        z.tuple([
          z.object({
            order_id: z.literal(orderId),
            kind: z.literal('charge'),
          }),
        ]).parse(rows);
      } finally {
        db.close();
      }
      await worker.kill();
      await startWorker(false);
      return orderId;
    },
  };
}

async function deploy(server: NativeProcess, admin: string, uri: string) {
  const deadline = Date.now() + 15_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    server.assertRunning();
    try {
      const response = await fetch(`${admin}/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) break;
      lastError = `Health returned HTTP ${response.status}`;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  if (Date.now() >= deadline)
    throw new Error(
      `Restate admin failed to start: ${String(lastError)}\n${server.log()}`,
    );

  const response = await fetch(`${admin}/deployments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uri }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(
      `Restate registration failed (${
        response.status
      }): ${await response.text()}\n${server.log()}`,
    );
}
