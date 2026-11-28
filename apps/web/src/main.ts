import {
  cafeSnapshotSchema,
  runConfigSchema,
  runtimeSchema,
  type CafeSnapshot,
  type Command,
  type Runtime,
} from '@actor-cafe/contract';
import { z } from 'zod';
import './style.css';

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.querySelector<T>(`#${id}`);
  if (!node) throw new Error(`Missing element: ${id}`);
  return node;
}

const form = element<HTMLFormElement>('run-form');
const runtimeField = element<HTMLSelectElement>('runtime');
const start = element<HTMLButtonElement>('start');
const connection = element('connection');
const runStatus = element('run-status');
const inspectorTitle = element('inspector-title');
const error = element('error');
const floor = element('floor');
const totals = element('totals');
const grinder = element('grinder');
const orders = element('orders');
const actors = element('actors');
const actions = element('actions');
const orderTable = element('order-table');
const noOrders = element('no-orders');
const inspectorPane = element('inspector-pane');
const inspectorEmpty = element('inspector-empty');
const inspectorLink = element<HTMLAnchorElement>('inspector-link');

const runtimeNames: Record<Runtime, string> = {
  rivet: 'XState + Rivet',
  restate: 'XState + Restate',
  cloudflare: 'XState + Cloudflare Durable Objects',
  temporal: 'XState + Temporal',
  workflow: 'XState + Vercel Workflow',
};
const runtimesSchema = z.object({ runtimes: z.array(runtimeSchema) });
const createdSchema = z.object({ id: z.string().min(1) });
const acceptedSchema = z.object({ accepted: z.literal(true) });
const errorSchema = z.object({ error: z.string() });

type Run = { id: string; runtime: Runtime; inspect: boolean };
let run: Run | undefined;
let snapshot: CafeSnapshot | undefined;
let inspectorFrame: HTMLIFrameElement | undefined;
let inspectorUrl: string | undefined;
let starting = false;
let sending = false;
let available = new Set<Runtime>();
let snapshotError = '';
let commandError = '';

function label(state: string) {
  return state
    .replaceAll(/([a-z\d])([A-Z])/g, '$1 $2')
    .replaceAll(/[-_]/g, ' ');
}

function create<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function showErrors() {
  error.textContent = commandError || snapshotError;
  error.hidden = !error.textContent;
}

function connectionState(state: 'ready' | 'pending' | 'offline', text: string) {
  connection.textContent = text;
  connection.dataset.state = state;
}

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  body?: unknown,
  timeout = 15_000,
) {
  const response = await fetch(path, {
    cache: 'no-store',
    signal: AbortSignal.timeout(timeout),
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = errorSchema.safeParse(data);
    throw new Error(
      detail.success
        ? detail.data.error
        : `Gateway returned HTTP ${response.status}.`,
    );
  }
  return schema.parse(data);
}

function runUrl(current: Run) {
  return `/api/${current.runtime}/runs/${encodeURIComponent(current.id)}`;
}

function updateStart() {
  const choice = runtimeSchema.safeParse(runtimeField.value);
  start.disabled =
    starting || sending || !choice.success || !available.has(choice.data);
  start.textContent = starting
    ? 'Starting…'
    : run
    ? 'Start another café'
    : 'Start café';
}

async function discoverRuntimes() {
  try {
    const result = await request('/api/runtimes', runtimesSchema);
    available = new Set(result.runtimes);
  } catch {
    available = new Set();
  }
  for (const option of runtimeField.options) {
    const parsed = runtimeSchema.safeParse(option.value);
    option.disabled = !parsed.success || !available.has(parsed.data);
    if (parsed.success)
      option.textContent =
        runtimeNames[parsed.data] + (option.disabled ? ' (offline)' : '');
  }
  const choice = runtimeSchema.safeParse(runtimeField.value);
  if (!choice.success || !available.has(choice.data)) {
    const first = Array.from(available)[0];
    if (first) runtimeField.value = first;
  }
  if (!run)
    connectionState(
      available.size ? 'ready' : 'offline',
      available.size ? 'Gateway connected' : 'Runtime unavailable',
    );
  updateStart();
  window.setTimeout(() => void discoverRuntimes(), 5_000);
}

function updateInspector(
  url: string | null,
  emptyText = 'Enable “Stream to Stately” and start a café to inspect its actors here.',
) {
  const parsed = url ? URL.parse(url) : null;
  const safeUrl =
    parsed && ['http:', 'https:'].includes(parsed.protocol)
      ? parsed.href
      : undefined;
  const singleUse =
    parsed?.pathname.endsWith('/claim') && parsed.searchParams.has('token');
  if (safeUrl !== inspectorUrl) {
    inspectorFrame?.remove();
    inspectorFrame = undefined;
    inspectorUrl = safeUrl;
    if (safeUrl) {
      inspectorFrame = create('iframe');
      inspectorFrame.title = 'Live Stately actor system';
      inspectorFrame.src = safeUrl;
      inspectorFrame.referrerPolicy = 'no-referrer';
      inspectorPane.append(inspectorFrame);
      if (!singleUse) inspectorLink.href = safeUrl;
      else inspectorLink.removeAttribute('href');
    } else inspectorLink.removeAttribute('href');
  }
  inspectorLink.hidden = !safeUrl || !!singleUse;
  inspectorEmpty.hidden = !!safeUrl;
  inspectorEmpty.textContent = emptyText;
}

function canCancel(order: CafeSnapshot['orders'][number]) {
  return (
    order.status === 'paying' ||
    order.status === 'queued' ||
    order.status === 'preparing'
  );
}

function updateButtons(state: CafeSnapshot | undefined) {
  for (const button of actions.querySelectorAll<HTMLButtonElement>('button')) {
    button.disabled =
      sending || starting || !!snapshotError || state?.status !== 'open';
  }
  for (const button of orders.querySelectorAll<HTMLButtonElement>('button')) {
    button.disabled =
      sending || starting || !!snapshotError || state?.status === 'closed';
  }
  updateStart();
}

function describeMetric(title: string, value: string | number) {
  const item = create('div');
  item.append(create('dt', title), create('dd', String(value)));
  return item;
}

function render(state: CafeSnapshot, previous?: CafeSnapshot) {
  floor.hidden = false;
  runStatus.textContent = label(state.status);
  runStatus.dataset.state = state.status;
  if (
    !previous ||
    JSON.stringify(previous.orders) !== JSON.stringify(state.orders)
  ) {
    totals.replaceChildren(
      describeMetric('In progress', state.orders.filter(canCancel).length),
      describeMetric(
        'Served',
        state.orders.filter((order) => order.status === 'served').length,
      ),
      describeMetric(
        'Cancelled',
        state.orders.filter((order) => order.status === 'cancelled').length,
      ),
      describeMetric(
        'Failed',
        state.orders.filter((order) => order.status === 'failed').length,
      ),
    );
    orderTable.hidden = state.orders.length === 0;
    noOrders.hidden = !orderTable.hidden;
    const focusedOrder =
      document.activeElement instanceof HTMLButtonElement
        ? document.activeElement.dataset.orderId
        : undefined;
    const rows = state.orders.map((order) => {
      const row = create('tr');
      const name = create('th', order.id, 'mono');
      name.scope = 'row';
      row.append(
        name,
        create('td', order.drink),
        create('td', label(order.status), 'state-cell'),
        create(
          'td',
          order.refunded ? 'Refunded' : order.paid ? 'Paid' : 'Pending',
        ),
      );
      const cell = create('td');
      if (canCancel(order)) {
        const button = create('button', 'Cancel');
        button.type = 'button';
        button.dataset.orderId = order.id;
        button.setAttribute('aria-label', `Cancel ${order.id}`);
        cell.append(button);
      }
      row.append(cell);
      return row;
    });
    orders.replaceChildren(...rows);
    if (focusedOrder !== undefined) {
      const replacement = Array.from(orders.querySelectorAll('button')).find(
        (button) => button.dataset.orderId === focusedOrder,
      );
      replacement?.focus({ preventScroll: true });
    }
  }
  if (
    !previous ||
    JSON.stringify(previous.grinder) !== JSON.stringify(state.grinder)
  ) {
    grinder.replaceChildren(
      describeMetric('Holder', state.grinder.holder ?? 'Available'),
      describeMetric('Waiting', state.grinder.queued.join(', ') || 'None'),
    );
  }
  if (
    !previous ||
    JSON.stringify(previous.actors) !== JSON.stringify(state.actors)
  ) {
    actors.replaceChildren(
      ...state.actors.map((actor) => {
        const row = create('li');
        row.append(
          create('span', actor.id, 'mono'),
          create('span', label(actor.kind), 'actor-kind'),
          create('span', label(actor.state)),
        );
        return row;
      }),
    );
  }
  updateInspector(
    state.inspectorUrl,
    run?.inspect
      ? 'Waiting for the Stately session.'
      : 'Stately streaming is disabled for this run.',
  );
  updateButtons(state);
}

async function poll(current: Run) {
  try {
    const state = await request(runUrl(current), cafeSnapshotSchema);
    if (current !== run) return;
    const previous = snapshot;
    snapshot = state;
    snapshotError = '';
    connectionState('ready', `${runtimeNames[current.runtime]} connected`);
    render(state, previous);
  } catch (cause) {
    if (current !== run) return;
    snapshotError =
      cause instanceof Error ? cause.message : 'Could not load the café.';
    connectionState('offline', 'Reconnecting');
    updateButtons(snapshot);
  }
  showErrors();
  if (current === run) window.setTimeout(() => void poll(current), 700);
}

async function send(command: Command) {
  const current = run;
  if (!current || sending || starting || snapshotError) return;
  commandError = '';
  sending = true;
  updateButtons(snapshot);
  showErrors();
  try {
    await request(`${runUrl(current)}/commands`, acceptedSchema, {
      requestId: crypto.randomUUID(),
      command,
    });
  } catch (cause) {
    commandError =
      cause instanceof Error ? cause.message : 'Could not send the command.';
  } finally {
    sending = false;
    updateButtons(snapshot);
    showErrors();
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (starting || sending) return;
  const formData = new FormData(form);
  const runtime = runtimeSchema.safeParse(formData.get('runtime'));
  if (!runtime.success || !available.has(runtime.data)) return;
  const config = runConfigSchema.safeParse({
    customers: Number(formData.get('customers')),
    baristas: Number(formData.get('baristas')),
    tickMs: Number(formData.get('tickMs')),
    inspect: formData.has('inspect'),
  });
  commandError = '';
  if (!config.success) {
    commandError = config.error.issues[0]?.message ?? 'Check the run settings.';
    showErrors();
    return;
  }
  starting = true;
  updateButtons(snapshot);
  showErrors();
  try {
    const value = await request(
      `/api/${runtime.data}/runs`,
      createdSchema,
      config.data,
      45_000,
    );
    run = { id: value.id, runtime: runtime.data, inspect: config.data.inspect };
    inspectorTitle.textContent = 'Stately Inspector';
    snapshot = undefined;
    snapshotError = '';
    floor.hidden = true;
    runStatus.textContent = 'Starting';
    delete runStatus.dataset.state;
    connectionState('pending', `Connecting to ${runtimeNames[runtime.data]}`);
    updateInspector(
      null,
      config.data.inspect
        ? 'Waiting for the Stately session.'
        : 'Stately streaming is disabled for this run.',
    );
    void poll(run);
  } catch (cause) {
    commandError =
      cause instanceof Error ? cause.message : 'Could not start the café.';
  } finally {
    starting = false;
    updateButtons(snapshot);
    showErrors();
  }
});

runtimeField.addEventListener('change', updateStart);
actions.addEventListener('click', (event) => {
  if (!(event.target instanceof HTMLButtonElement)) return;
  const command = event.target.dataset.command;
  if (command === 'espresso' || command === 'latte')
    void send({ type: 'arrival', drink: command });
  else if (command === 'close') void send({ type: 'close' });
});
orders.addEventListener('click', (event) => {
  if (event.target instanceof HTMLButtonElement && event.target.dataset.orderId)
    void send({ type: 'cancel', orderId: event.target.dataset.orderId });
});

void discoverRuntimes();
