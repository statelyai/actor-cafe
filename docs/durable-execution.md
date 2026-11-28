# Durable XState integration notes

The comparison keeps the actor system constant. Hosts differ in how they admit commands, store progress, wake for timers, and observe a run. Each adapter runs one café per native runtime instance or workflow.

<!-- Host semantics from apps and packages/cafe/src/turn.ts -->

| Host | Integration difficulty |
| --- | --- |
| Rivet | The actor needs a durable queue and an acknowledgement after the XState turn commits. A queue timeout can race an already accepted message. The adapter looks up the queue before deciding whether to deliver the timer. |
| Restate | Durable I/O belongs in Restate operations. The adapter runs XState inside a journaled step and tracks a revision so stale delayed self-messages cannot advance the run. Invalid ingress payloads return a terminal 400 so the next command can run. |
| Cloudflare | Each Durable Object has one alarm. The XState scheduler has many child timers. The host stores the journal and next alarm in the same storage transaction and reconciles missing alarms on activation. A subsequent read also advances an overdue turn if an interrupted local alarm was not redelivered. Before an alarm handler performs effects, it commits a fallback alarm. Killing a local workerd process during payment otherwise left a café with a pending logical timer and no wakeup. |
| Temporal | Workflow code runs with replay restrictions. The host uses signals and durable timer conditions and invokes the XState turn as an Activity. Returning the journal from every Activity increases workflow history over time. The native workflow ID rejects reuse after close. |
| Vercel Workflow | Workflow code runs in a sandbox. XState turns need step boundaries, the hook iterator must retain an outstanding read when a timer wins, and the dashboard needs a separate current-state read model. The Next.js startup hook starts the Local World to recover runs after a restart. Coalescing several overdue deliveries also hid intermediate actor states in the dashboard, so the shared driver now publishes one turn at a time. The adapter checks a buffered hook message before firing an overdue timer. A native start hook prevents concurrent starts, and the read model retains café identity after the hook is released. |

The shared turn driver queues future-stamped commands until their timestamp. It orders commands against due timers and gives the timer an exact tie. Payment providers return explicit declines. Infrastructure errors escape the turn so the host can retry the same idempotent payment.

Cloudflare Workflows could use the same step and wait design as Temporal or Vercel. Durable Objects exercise a different host primitive. Inngest, Trigger.dev, and AWS Step Functions are additional candidates. Inngest has event and targeted signal waits, Trigger.dev has task waitpoints, and Step Functions Standard has task-token callbacks. Those examples are outside this comparison.

- [Cloudflare Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [Temporal TypeScript Workflow primitives](https://docs.temporal.io/develop/typescript)
- [Vercel Workflow SDK](https://github.com/vercel/workflow)
- [Inngest durable event waits](https://www.inngest.com/docs/durable-execution/primitives/step-waitforevent)
- [Trigger.dev waitpoints](https://trigger.dev/changelog/waitpoints)
- [AWS Step Functions callbacks](https://docs.aws.amazon.com/step-functions/latest/dg/callback-task-sample-sqs.html)

## Upstream work in XState

1. **Expose a single durable turn.** The shared adapter uses `createDurable`, drives effects, drains child completions, and yields twice to let asynchronous completion messages settle. Provide a documented turn API that resolves at quiescence and returns the next wake and committed transitions. This would remove the host's guess about when child work is finished.
2. **Checkpoint and restore the actor tree.** The object and workflow examples rebuild the graph by replaying journaled deliveries. Each pass replays earlier turns and copies a growing journal. Provide a versioned checkpoint that covers spawned actors, logical addresses, mailbox state, timers, and in-flight durable effects. Support restore plus replay of the suffix and reject incompatible changes explicitly.
3. **Provide a portable timer and mailbox policy.** Hosts need typed timer keys and absolute deadlines. They also need a rule for an accepted message racing a late alarm. The comparison orders by accepted time and gives the timer an exact tie. Put selection and timer identity in XState so hosts supply input timestamps and native wakeups.
4. **Expose stable effect identity and retries.** The sample creates effect keys from the turn, operation index, and actor address. Let an effect carry a stable ID and distinguish retryable infrastructure failures from completed domain failures. A stable ID can also become the provider's idempotency key. The provider still owns idempotent payment commits.
5. **Provide committed inspection checkpoints.** Rivet explicitly restores the previous inspector graph before publishing fresh events. The other hosts rebuild committed actor trees for Stately from persisted turns. An inspector-ready checkpoint and a committed event batch would remove the replay and preserve live transition history across restarts.
6. **Validate durable input and isolate sandbox dependencies.** The first adapter pass skipped the model's input parser and scheduled a timer with a non-finite timestamp. Validate input once and fail before calling a platform timer API. Document which XState durable functions can run inside a deterministic workflow and include a bundler smoke test for that entry point.
