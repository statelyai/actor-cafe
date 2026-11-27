import { start, resumeHook } from 'workflow/api';
import { HookConflictError } from 'workflow/errors';
import { cafeHttp } from '@actor-cafe/cafe/http';
import { cafeWorkflow } from '../../../../src/workflow.ts';
import { hasRun, readSnapshot, readJournal } from '../../../../src/storage.ts';

const backend: Parameters<typeof cafeHttp>[1] = {
  async start(id, config) {
    if (hasRun(id)) return;
    try {
      await start(cafeWorkflow, [id, config], {
        experimental_hook: { token: id },
      });
    } catch (error) {
      if (!HookConflictError.is(error)) throw error;
    }
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      try {
        readSnapshot(id);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new Error('Workflow café did not initialize.');
  },
  async command(id, requestId, command) {
    await resumeHook(id, { requestId, command, acceptedAt: Date.now() });
  },
  async journal(id) {
    return readJournal(id);
  },
  async snapshot(id) {
    return readSnapshot(id);
  },
};
export const GET = (request: Request) => cafeHttp(request, backend);
export const POST = GET;
