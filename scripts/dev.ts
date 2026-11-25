import { fork, spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const processes: ChildProcess[] = [];
const groups = new Set<ChildProcess>();
const data = resolve('.cafe', 'comparison');
const cli = process.env.npm_execpath ?? 'pnpm';
const rivetPort = 16480;
const restate = { node: 15122, ingress: 18080, admin: 19070, service: 19080 };
const baseUrl = (port: number) => `http://127.0.0.1:${port}`;
let enginePid: number | undefined;
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of processes.slice().reverse())
    signalChild(child, 'SIGTERM');
  if (enginePid) {
    try {
      process.kill(enginePid, 'SIGTERM');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  globalThis
    .setTimeout(() => {
      for (const child of processes)
        if (child.exitCode === null && child.signalCode === null)
          signalChild(child, 'SIGKILL');
    }, 3_000)
    .unref();
}
function signalChild(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  try {
    process.kill(groups.has(child) ? -child.pid : child.pid, signal);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'ESRCH'
    )
      throw error;
  }
}

function command(binary: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const child = spawn(binary, args, {
    detached: true,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  groups.add(child);
  return manage(child);
}

async function waitFor(label: string, isReady: () => Promise<boolean>) {
  const deadline = Date.now() + 60_000;
  while (!stopping && Date.now() < deadline) {
    try {
      if (await isReady()) return;
    } catch {}
    await delay(200);
  }
  throw new Error(`${label} startup timed out.`);
}

const waitHttp = (port: number) =>
  waitFor(baseUrl(port), async () => {
    const response = await fetch(`${baseUrl(port)}/healthz`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  });

async function startComparison(env: NodeJS.ProcessEnv) {
  const ports = {
    cloudflare: 8787,
    temporal: 4301,
    temporalServer: 7233,
    workflow: 4302,
  };
  command(
    cli,
    [
      '--filter',
      '@actor-cafe/cloudflare',
      'dev',
      '--persist-to',
      resolve(data, 'objects'),
    ],
    { WRANGLER_SEND_METRICS: 'false' },
  );
  command(cli, ['--filter', '@actor-cafe/workflow', 'dev'], {
    WORKFLOW_LOCAL_BASE_URL: baseUrl(ports.workflow),
    WORKFLOW_LOCAL_DATA_DIR: resolve(data, 'workflow'),
    CAFE_PAYMENT_DB: resolve(data, 'workflow-payments.sqlite'),
  });
  command(process.env.TEMPORAL_CLI ?? 'temporal', [
    'server',
    'start-dev',
    '--ip',
    '127.0.0.1',
    '--port',
    String(ports.temporalServer),
    '--headless',
    '--db-filename',
    resolve(data, 'temporal.sqlite'),
  ]);
  await waitFor(
    'Temporal',
    () =>
      new Promise((resolve) => {
        const socket = connect(ports.temporalServer, '127.0.0.1');
        socket.once('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.once('error', () => resolve(false));
      }),
  );
  const temporal = ready(
    node('apps/temporal/src/main.ts', [], {
      TEMPORAL_ADDRESS: `127.0.0.1:${ports.temporalServer}`,
      CAFE_HTTP_PORT: String(ports.temporal),
      CAFE_PAYMENT_DB: resolve(data, 'temporal-payments.sqlite'),
    }),
  );
  await Promise.all([
    temporal,
    waitHttp(ports.cloudflare),
    waitHttp(ports.workflow),
  ]);
  env.CLOUDFLARE_CAFE_URL = baseUrl(ports.cloudflare);
  env.TEMPORAL_CAFE_URL = baseUrl(ports.temporal);
  env.WORKFLOW_CAFE_URL = baseUrl(ports.workflow);
}

function manage(child: ChildProcess) {
  processes.push(child);
  child.once('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
    stop();
  });
  child.once('exit', (code) => {
    if (stopping) return;
    console.error(`Demo process exited (${code ?? 'signal'}).`);
    process.exitCode = 1;
    stop();
  });
  return child;
}
function node(file: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return manage(
    fork(resolve(file), args, {
      execArgv: ['--import', 'tsx'],
      env: { ...process.env, ...env },
    }),
  );
}
function ready(child: ChildProcess) {
  return new Promise<void>((resolve, reject) => {
    const timeout = globalThis.setTimeout(
      () => reject(new Error('Runner startup timed out.')),
      45_000,
    );
    child.once('exit', () => {
      clearTimeout(timeout);
      reject(new Error('Runner exited during startup.'));
    });
    child.on('message', (packet: unknown) => {
      if (!packet || typeof packet !== 'object' || !('type' in packet)) return;
      if ('enginePid' in packet && typeof packet.enginePid === 'number')
        enginePid = packet.enginePid;
      if (packet.type === 'ready') {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
}
async function registerRestate() {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline && !stopping) {
    try {
      const response = await fetch(`${baseUrl(restate.admin)}/deployments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ uri: baseUrl(restate.service) }),
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
      if (response.status < 500 && response.status !== 409)
        throw new TypeError(await response.text());
      if (response.status === 409) {
        const installed = await fetch(
          `${baseUrl(restate.admin)}/services/Cafe`,
        );
        if (installed.ok) return;
      }
    } catch (error) {
      if (error instanceof TypeError && error.message !== 'fetch failed')
        throw error;
    }
    await delay(300);
  }
  throw new Error('Restate deployment registration timed out.');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, stop);
try {
  await mkdir(data, { recursive: true });
  const rivetReady = ready(
    node(
      'apps/rivet/src/fixtures/rivet-worker.ts',
      [resolve(data, 'rivet'), String(rivetPort), 'normal'],
      {
        RIVET_LOG_LEVEL: 'error',
        RUST_LOG: 'error',
      },
    ),
  );
  const env: NodeJS.ProcessEnv = { RIVET_CAFE_ENDPOINT: baseUrl(rivetPort) };
  if (process.env.CAFE_RIVET_ONLY !== '1') {
    manage(
      spawn('restate-server', ['--base-dir', resolve(data, 'restate')], {
        stdio: 'inherit',
        env: {
          ...process.env,
          RESTATE_BIND_ADDRESS: `127.0.0.1:${restate.node}`,
          RESTATE_ADVERTISED_ADDRESS: baseUrl(restate.node),
          RESTATE_ADMIN__BIND_ADDRESS: `127.0.0.1:${restate.admin}`,
          RESTATE_INGRESS__BIND_ADDRESS: `127.0.0.1:${restate.ingress}`,
        },
      }),
    );
    await Promise.all([
      rivetReady,
      ready(
        node('apps/restate/src/main.ts', [], {
          RESTATE_SERVICE_PORT: String(restate.service),
          RESTATE_PAYMENT_DB: resolve(data, 'restate-payments.sqlite'),
        }),
      ).then(registerRestate),
    ]);
    env.RESTATE_CAFE_INGRESS = baseUrl(restate.ingress);
  } else await rivetReady;
  if (process.argv.includes('--all')) await startComparison(env);
  node('scripts/gateway.ts', [], env);
  command(cli, ['--filter', '@actor-cafe/web', 'dev']);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
  stop();
}
