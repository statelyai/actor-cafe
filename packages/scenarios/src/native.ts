import { fork, spawn, type ChildProcess } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createHttpBackend } from '@actor-cafe/cafe/http';
import type { CafeBackend, Runtime } from '@actor-cafe/contract';
import { z } from 'zod';

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
    const port = randomInt(20000, 45000);
    const servers = [];
    try {
      for (const offset of [0, ...offsets])
        servers.push(await reserve(port + offset));
      return port;
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

  constructor(
    readonly child: ChildProcess,
    readonly group = false,
  ) {
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
    if (this.group) process.kill(-this.child.pid, 'SIGKILL');
    else this.child.kill('SIGKILL');
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
    const { createRivetBackend } =
      await import('../../../apps/rivet/src/rivet/backend.ts');
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

  if (
    runtime === 'cloudflare' ||
    runtime === 'temporal' ||
    runtime === 'workflow'
  )
    return extraFixture(runtime, chargeFault, directory, processes);

  const { createRestateBackend } =
    await import('../../../apps/restate/src/backend.ts');
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

const project = fileURLToPath(new URL('../../../', import.meta.url));

function startProcess(
  processes: NativeProcess[],
  binary: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
) {
  const worker = new NativeProcess(
    spawn(binary, args, {
      cwd,
      env: { ...process.env, ...env },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
    true,
  );
  processes.push(worker);
  return worker;
}

async function waitUntil<T>(
  worker: NativeProcess,
  name: string,
  read: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + 75_000;
  while (Date.now() < deadline) {
    worker.assertRunning();
    try {
      const result = await read();
      if (result !== undefined) return result;
    } catch {
      // The process may have bound its port before loading its handlers.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${name}\n${worker.log()}`);
}

async function httpReady(worker: NativeProcess, endpoint: string) {
  await waitUntil(worker, endpoint, async () => {
    const response = await fetch(`${endpoint}/healthz`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok ? true : undefined;
  });
}

async function extraFixture(
  runtime: 'cloudflare' | 'temporal' | 'workflow',
  chargeFault: boolean,
  directory: string,
  processes: NativeProcess[],
): Promise<Fixture> {
  const port = await freePorts([1, 2]);
  const endpoint = url(port);
  const backend = createHttpBackend(endpoint);
  const pnpm = process.env.npm_execpath ?? 'pnpm';
  const dbPath = join(directory, 'payments.sqlite');
  if (runtime === 'temporal') {
    const temporal = startProcess(
      processes,
      process.env.TEMPORAL_CLI ?? 'temporal',
      [
        'server',
        'start-dev',
        '--ip',
        loopback,
        '--port',
        String(port + 1),
        '--headless',
        '--db-filename',
        join(directory, 'temporal.sqlite'),
      ],
      project,
    );
    await waitUntil(temporal, 'Temporal service', async () => {
      const socket = await import('node:net');
      return new Promise<true | undefined>((resolve) => {
        const client = socket.connect(port + 1, loopback);
        client.once('connect', () => {
          client.destroy();
          resolve(true);
        });
        client.once('error', () => resolve(undefined));
      });
    });
  }

  async function startWorker(fault: boolean) {
    const env = {
      CAFE_PAYMENT_DB: dbPath,
      CAFE_CRASH_AFTER_CHARGE: fault ? '1' : '0',
    };
    if (runtime === 'temporal') {
      const worker = forkWorker(
        new URL('../../../apps/temporal/src/main.ts', import.meta.url),
        [],
        {
          ...env,
          TEMPORAL_ADDRESS: addr(port + 1),
          CAFE_HTTP_PORT: String(port),
        },
      );
      processes.push(worker);
      await worker.wait('ready');
      return worker;
    }
    const worker =
      runtime === 'workflow'
        ? startProcess(
            processes,
            pnpm,
            [
              'exec',
              'next',
              'dev',
              '--hostname',
              loopback,
              '--port',
              String(port),
            ],
            join(project, 'apps/workflow'),
            {
              ...env,
              WORKFLOW_LOCAL_DATA_DIR: join(directory, 'workflow'),
              WORKFLOW_LOCAL_BASE_URL: endpoint,
            },
          )
        : startProcess(
            processes,
            pnpm,
            [
              'exec',
              'wrangler',
              'dev',
              '--local',
              '--ip',
              loopback,
              '--port',
              String(port),
              '--persist-to',
              join(directory, 'objects'),
              '--var',
              `CAFE_FAULT:${fault ? '1' : '0'}`,
            ],
            join(project, 'apps/cloudflare'),
            {
              WRANGLER_SEND_METRICS: 'false',
            },
          );
    await httpReady(worker, endpoint);
    return worker;
  }

  const worker = await startWorker(chargeFault);
  return {
    backend,
    async crashAndRestart(runId) {
      const orderId = await waitUntil(
        worker,
        'durable payment commit',
        async () => {
          if (runtime === 'cloudflare') {
            const res = await fetch(`${endpoint}/fixture/${runId}/charge`);
            if (!res.ok) return;
            return (
              z
                .string()
                .nullable()
                .parse(await res.json()) ?? undefined
            );
          }
          await access(dbPath);
          const db = new DatabaseSync(dbPath, { readOnly: true });
          try {
            const rows = db
              .prepare(
                "SELECT order_id FROM payments WHERE cafe_id = ? AND kind = 'charge'",
              )
              .all(runId);
            if (!rows.length) return;
            return z.tuple([z.object({ order_id: z.string() })]).parse(rows)[0]
              .order_id;
          } finally {
            db.close();
          }
        },
      );
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
