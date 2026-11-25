import { withWorkflow } from 'workflow/next';

export default withWorkflow({
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
});
