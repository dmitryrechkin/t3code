import {
  ModelSelection,
  OrchestratorMcpFailure,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadListResult,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadSendResult,
  OrchestratorMcpThreadWaitResult,
  OrchestrationV2DispatchCommandResult,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  RunId,
  ThreadId,
  ThreadMetadataMcpUpdateResult,
  TrimmedNonEmptyString,
  type OrchestratorMcpThreadListItem,
  type OrchestratorMcpThreadStatus,
  type OrchestratorMcpThreadTimelineItem,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { mcpToolSession, type McpToolSession } from "../mcp/AcpMcpStdioBridge.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

/**
 * Short enough that a run which stops to ask the user something is noticed
 * soon, since `t3_thread_wait` only returns on a terminal run.
 */
const WAIT_SLICE_MS = 15_000;
const READ_PAGE_LIMIT = 100;
const TITLE_MAX_CHARS = 80;

export class ThreadServerNotRunningError extends Schema.TaggedError<ThreadServerNotRunningError>()(
  "ThreadServerNotRunningError",
  { baseDir: Schema.String },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return `No running T3 Code server uses ${this.baseDir}. Start T3 Code, then retry.`;
  }
}

export class ThreadServerUnreachableError extends Schema.TaggedError<ThreadServerUnreachableError>()(
  "ThreadServerUnreachableError",
  { origin: Schema.String, cause: Schema.Defect() },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    const reason = this.cause instanceof Error ? ` ${this.cause.message}` : "";
    return `Could not reach the T3 Code server at ${this.origin}.${reason}`;
  }
}

export class ThreadToolFailedError extends Schema.TaggedError<ThreadToolFailedError>()(
  "ThreadToolFailedError",
  { tool: Schema.String, detail: Schema.String },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return this.detail;
  }
}

export class ThreadUsageError extends Schema.TaggedError<ThreadUsageError>()("ThreadUsageError", {
  detail: Schema.String,
}) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return this.detail;
  }
}

export class ThreadProjectNotFoundError extends Schema.TaggedError<ThreadProjectNotFoundError>()(
  "ThreadProjectNotFoundError",
  { identifier: Schema.String },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return `No T3 Code project matches '${this.identifier}'. Pass a project id or a path inside a project.`;
  }
}

/** Exit code 2 lets a script tell "needs a human" apart from a failed run. */
export class ThreadNeedsInputError extends Schema.TaggedError<ThreadNeedsInputError>()(
  "ThreadNeedsInputError",
  { threadId: ThreadId },
) {
  override readonly [Runtime.errorReported] = false;
  override readonly [Runtime.errorExitCode] = 2;

  override get message(): string {
    return `Thread ${this.threadId} is waiting for an answer. Open it in T3 Code to respond.`;
  }
}

export class ThreadRunEndedError extends Schema.TaggedError<ThreadRunEndedError>()(
  "ThreadRunEndedError",
  { threadId: ThreadId, status: Schema.String, error: Schema.optional(Schema.String) },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    const reason = this.error === undefined ? "." : `: ${this.error}`;
    return `Thread ${this.threadId} stopped with status ${this.status}${reason}`;
  }
}

/** Exit code 3 lets a script tell "still running at the deadline" from a failed run. */
export class ThreadDeadlineError extends Schema.TaggedError<ThreadDeadlineError>()(
  "ThreadDeadlineError",
  { threadId: ThreadId, timeoutMs: Schema.Number },
) {
  override readonly [Runtime.errorReported] = false;
  override readonly [Runtime.errorExitCode] = 3;

  override get message(): string {
    return `Thread ${this.threadId} is still running after ${this.timeoutMs}ms.`;
  }
}

const ThreadCliError = Schema.Union([
  ThreadServerNotRunningError,
  ThreadServerUnreachableError,
  ThreadToolFailedError,
  ThreadUsageError,
  ThreadProjectNotFoundError,
  ThreadNeedsInputError,
  ThreadRunEndedError,
  ThreadDeadlineError,
]);
const isThreadCliError = Schema.is(ThreadCliError);

/**
 * These errors are expected outcomes for a script, so they print as one line
 * on stderr instead of the runtime's logged stack trace.
 */
export const reportThreadErrors = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.tapError((error) =>
      isThreadCliError(error) ? Console.error(error.message) : Effect.void,
    ),
  );

const decodeFailureText = Schema.decodeUnknownOption(Schema.fromJsonString(OrchestratorMcpFailure));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export const printJson = (value: unknown) => Console.log(encodeJson(value));

const ToolResult = Schema.Struct({
  isError: Schema.optional(Schema.Boolean),
  structuredContent: Schema.optional(Schema.Unknown),
  content: Schema.optional(
    Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
  ),
});

const decodeToolResult = Schema.decodeUnknownEffect(ToolResult);

const ProjectListResult = Schema.Struct({
  projects: Schema.Array(
    Schema.Struct({ id: ProjectId, title: Schema.String, workspaceRoot: Schema.String }),
  ),
  nextCursor: Schema.NullOr(Schema.Int),
});

const ThreadLaunchResult = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  runId: Schema.NullOr(RunId),
});

const OrganizeThreadResult = Schema.Union([
  OrchestrationV2DispatchCommandResult,
  Schema.Struct({ settlesWhenTurnEnds: Schema.Literal(true) }),
]);

const ThreadConfiguration = Schema.Struct({
  threadId: ThreadId,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
const ThreadConfigureResult = Schema.Union([
  OrchestrationV2DispatchCommandResult,
  ThreadConfiguration,
]);

const toolFailureDetail = (result: typeof ToolResult.Type) => {
  const text = result.content?.find((part) => part.text !== undefined)?.text ?? "";
  return Option.match(decodeFailureText(text), {
    onNone: () => text || "The tool call failed.",
    onSome: (failure) => failure.message,
  });
};

const makeThreadTools = (session: McpToolSession, origin: string) => {
  const unexpected = (tool: string) =>
    new ThreadToolFailedError({
      tool,
      detail: `The server sent an unexpected ${tool} result. Update the t3 CLI to match the server.`,
    });
  return {
    call: Effect.fn("cli.thread.callTool")(function* <S extends Schema.Decoder<unknown>>(
      tool: string,
      args: Readonly<Record<string, unknown>>,
      schema: S,
    ): Effect.fn.Return<S["Type"], ThreadServerUnreachableError | ThreadToolFailedError> {
      const raw = yield* session
        .call(tool, args)
        .pipe(Effect.mapError((cause) => new ThreadServerUnreachableError({ origin, cause })));
      const result = yield* decodeToolResult(raw).pipe(Effect.mapError(() => unexpected(tool)));
      if (result.isError === true) {
        return yield* new ThreadToolFailedError({ tool, detail: toolFailureDetail(result) });
      }
      return yield* Schema.decodeUnknownEffect(schema)(result.structuredContent).pipe(
        Effect.mapError(() => unexpected(tool)),
      );
    }),
  };
};
export type ThreadTools = ReturnType<typeof makeThreadTools>;

/**
 * Signs in as a short-lived MCP client of the running server, the same way an
 * outside agent does, and revokes that session when the command ends.
 */
export const withThreadTools = Effect.fn("cli.thread.withThreadTools")(function* <A, E, R>(
  flags: { readonly baseDir: Option.Option<string> },
  run: (tools: ThreadTools) => Effect.Effect<A, E, R>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  return yield* Effect.gen(function* () {
    const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(runtimeState)) {
      return yield* new ThreadServerNotRunningError({ baseDir: config.baseDir });
    }
    const origin = runtimeState.value.origin;
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const issued = yield* Effect.acquireRelease(
      environmentAuth.issueMcpClientSession({
        label: "t3 thread cli",
        // The CLI runs as the machine's owner. New threads still start at
        // the project's default mode, never at this ceiling by default.
        access: "full-access",
        peerLink: false,
        client: { deviceType: "bot" },
      }),
      (session) =>
        environmentAuth.revokeSession(session.sessionId).pipe(Effect.ignore({ log: true })),
    );
    const session = yield* mcpToolSession({
      endpoint: new URL("/mcp", origin).href,
      authorization: `Bearer ${issued.token}`,
      clientName: "t3-thread-cli",
    }).pipe(Effect.mapError((cause) => new ThreadServerUnreachableError({ origin, cause })));
    return yield* run(makeThreadTools(session, origin));
  }).pipe(
    Effect.scoped,
    Effect.provide(
      EnvironmentAuth.layerRuntime.pipe(
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
      ),
    ),
  );
});

const readMessageArgument = Effect.fn("cli.thread.readMessage")(function* (argument: string) {
  const text =
    argument === "-"
      ? yield* Stdio.Stdio.pipe(
          Effect.flatMap((stdio) => stdio.stdin.pipe(Stream.decodeText(), Stream.mkString)),
        )
      : argument;
  if (text.trim().length === 0) {
    return yield* new ThreadUsageError({ detail: "The message is empty." });
  }
  return text;
});

const listAllProjects = Effect.fn("cli.thread.listAllProjects")(function* (tools: ThreadTools) {
  const projects: Array<(typeof ProjectListResult.Type)["projects"][number]> = [];
  let cursor: number | null = 0;
  while (cursor !== null) {
    const page: typeof ProjectListResult.Type = yield* tools.call(
      "t3_project_list",
      { cursor, limit: 100 },
      ProjectListResult,
    );
    projects.push(...page.projects);
    cursor = page.nextCursor;
  }
  return projects;
});

/** A project id, or a path inside a project's folder (deepest project wins). */
const resolveProject = Effect.fn("cli.thread.resolveProject")(function* (
  tools: ThreadTools,
  identifier: string,
) {
  const projects = yield* listAllProjects(tools);
  const byId = projects.find((project) => project.id === identifier);
  if (byId !== undefined) return byId;

  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  // Stored roots keep the path the project was added with, which may pass
  // through a symlink (macOS /tmp), so both sides compare as real paths.
  const realPath = (value: string) =>
    fileSystem.realPath(value).pipe(Effect.orElseSucceed(() => value));
  const target = yield* realPath(path.resolve(yield* HostProcess.WorkingDirectory, identifier));
  const roots = yield* Effect.forEach(projects, (project) =>
    Effect.map(realPath(project.workspaceRoot), (root) => ({ project, root })),
  );
  const containing = roots
    .filter(({ root }) => {
      const relative = path.relative(root, target);
      return (
        relative === "" ||
        (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
      );
    })
    .toSorted((left, right) => right.root.length - left.root.length)[0];
  if (containing === undefined) {
    return yield* new ThreadProjectNotFoundError({ identifier });
  }
  return containing.project;
});

/** Every item on a timeline view, oldest first. */
const readTimeline = Effect.fn("cli.thread.readTimeline")(function* (
  tools: ThreadTools,
  threadId: ThreadId,
  view: "messages" | "activity",
) {
  const items: Array<OrchestratorMcpThreadTimelineItem> = [];
  let afterPosition: number | undefined;
  let page: OrchestratorMcpThreadReadResult;
  do {
    page = yield* tools.call(
      "t3_thread_read",
      {
        threadId,
        view,
        limit: READ_PAGE_LIMIT,
        runLimit: 1,
        ...(afterPosition === undefined ? {} : { afterPosition }),
      },
      OrchestratorMcpThreadReadResult,
    );
    items.push(...page.items);
    afterPosition = page.nextPosition ?? undefined;
  } while (page.hasMore && afterPosition !== undefined);
  return { thread: page.thread, items };
});

/**
 * The latest `count` user and assistant messages, oldest first. Positions
 * count every timeline item, so the read starts near the end and widens
 * backward only while tool and plan items leave too few messages.
 */
export const readLatestMessages = Effect.fn("cli.thread.readLatestMessages")(function* (
  tools: ThreadTools,
  threadId: ThreadId,
  count: number,
) {
  let { thread } = yield* tools.call(
    "t3_thread_read",
    { threadId, limit: 1, runLimit: 1 },
    OrchestratorMcpThreadReadResult,
  );
  let messages: Array<OrchestratorMcpThreadTimelineItem> = [];
  // The newest window has no upper bound, so items added since the first
  // read are still shown.
  let before: number | undefined;
  let start = thread.itemCount;
  let span = Math.max(count, READ_PAGE_LIMIT);
  do {
    const end = before;
    start = Math.max(0, start - span);
    const window: Array<OrchestratorMcpThreadTimelineItem> = [];
    let afterPosition = start - 1;
    let page: OrchestratorMcpThreadReadResult;
    do {
      page = yield* tools.call(
        "t3_thread_read",
        {
          threadId,
          view: "messages",
          limit: READ_PAGE_LIMIT,
          runLimit: 1,
          ...(afterPosition < 0 ? {} : { afterPosition }),
        },
        OrchestratorMcpThreadReadResult,
      );
      window.push(
        ...page.items.filter(
          (item) =>
            (item.type === "user_message" || item.type === "assistant_message") &&
            (end === undefined || item.position < end),
        ),
      );
      afterPosition = page.nextPosition ?? Number.POSITIVE_INFINITY;
    } while (page.hasMore && afterPosition < (end ?? Number.POSITIVE_INFINITY) - 1);
    thread = page.thread;
    // A window can hold the whole --messages count, too many to spread as arguments.
    messages = window.concat(messages);
    before = start;
    span *= 2;
  } while (messages.length < count && start > 0);
  return { thread, messages: messages.slice(Math.max(0, messages.length - count)) };
});

/** Item text past the read's per-item cap. */
const readFullText = Effect.fn("cli.thread.readFullText")(function* (
  tools: ThreadTools,
  threadId: ThreadId,
  item: OrchestratorMcpThreadTimelineItem,
) {
  let text = item.text ?? "";
  let nextTextOffset = item.textTruncated ? (item.nextTextOffset ?? null) : null;
  while (nextTextOffset !== null) {
    const page = yield* tools.call(
      "t3_thread_read",
      { threadId, itemId: item.itemId, textOffset: nextTextOffset, runLimit: 1 },
      OrchestratorMcpThreadReadResult,
    );
    const chunk = page.items.find((candidate) => candidate.itemId === item.itemId);
    if (chunk === undefined) break;
    text += chunk.text ?? "";
    nextTextOffset = chunk.textTruncated ? (chunk.nextTextOffset ?? null) : null;
  }
  return text;
});

/** The run's last assistant message, or its last error when it did not complete. */
const runResultText = Effect.fn("cli.thread.runResultText")(function* (
  tools: ThreadTools,
  threadId: ThreadId,
  runId: RunId,
  type: "assistant_message" | "error",
) {
  const { items } = yield* readTimeline(
    tools,
    threadId,
    type === "assistant_message" ? "messages" : "activity",
  );
  const item = items.findLast((candidate) => candidate.runId === runId && candidate.type === type);
  return item === undefined ? null : yield* readFullText(tools, threadId, item);
});

type WaitOutcome =
  | {
      readonly type: "ended";
      readonly runId: RunId | null;
      readonly status: OrchestratorMcpThreadStatus;
    }
  | { readonly type: "needs_input" };

/**
 * Waits for this exact run, following a restart to its continuation, so a
 * message another client sends meanwhile cannot stand in for its result.
 */
export const waitForRun = Effect.fn("cli.thread.waitForRun")(function* (
  tools: ThreadTools,
  threadId: ThreadId,
  runId: RunId,
) {
  const waitSlice = (timeoutMs: number) =>
    tools.call("t3_thread_wait", { threadId, runId, timeoutMs }, OrchestratorMcpThreadWaitResult);
  const ended = (waited: OrchestratorMcpThreadWaitResult) =>
    ({ type: "ended", runId: waited.runId, status: waited.status }) satisfies WaitOutcome;
  while (true) {
    const waited = yield* waitSlice(WAIT_SLICE_MS);
    if (!waited.timedOut) return ended(waited);
    // A pending request on this run, or on an earlier run this one is queued
    // behind, blocks it until someone answers.
    const { thread } = yield* tools.call(
      "t3_thread_read",
      { threadId, limit: 1, runLimit: 1 },
      OrchestratorMcpThreadReadResult,
    );
    if (thread.pendingRequestCount > 0) {
      // The count is thread-wide: if this run ended since the slice, the
      // request belongs to a later run.
      const recheck = yield* waitSlice(1);
      return recheck.timedOut ? ({ type: "needs_input" } satisfies WaitOutcome) : ended(recheck);
    }
  }
});

/** Prints a finished run's reply or error, or its JSON summary. */
const reportRun = Effect.fn("cli.thread.reportRun")(function* (
  tools: ThreadTools,
  input: {
    readonly threadId: ThreadId;
    readonly runId: RunId | null;
    readonly status: OrchestratorMcpThreadStatus;
    readonly json: boolean;
  },
) {
  const reply =
    input.status === "completed" && input.runId !== null
      ? yield* runResultText(tools, input.threadId, input.runId, "assistant_message")
      : null;
  const error =
    input.runId === null || input.status === "completed" || input.status === "waiting"
      ? null
      : yield* runResultText(tools, input.threadId, input.runId, "error");
  if (input.json) {
    yield* printJson({
      threadId: input.threadId,
      runId: input.runId,
      status: input.status,
      reply,
      error,
    });
  } else if (reply !== null) {
    yield* Console.log(reply);
  }
  return { reply, error };
});

/**
 * With --json the result always reaches stdout, so a script keeps the thread
 * id even when the run fails.
 */
const finishRun = Effect.fn("cli.thread.finishRun")(function* (
  tools: ThreadTools,
  input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly json: boolean;
  },
) {
  const outcome = yield* waitForRun(tools, input.threadId, input.runId);
  const report = yield* reportRun(tools, {
    threadId: input.threadId,
    runId: outcome.type === "ended" ? (outcome.runId ?? input.runId) : input.runId,
    status: outcome.type === "ended" ? outcome.status : "waiting",
    json: input.json,
  });
  if (outcome.type === "needs_input") {
    return yield* new ThreadNeedsInputError({ threadId: input.threadId });
  }
  if (outcome.type === "ended" && outcome.status !== "completed") {
    return yield* new ThreadRunEndedError({
      threadId: input.threadId,
      status: outcome.status,
      ...(report.error === null ? {} : { error: report.error }),
    });
  }
});

/** Actions `t3_thread_organize` accepts. */
export const ORGANIZE_ACTIONS = [
  "pin",
  "unpin",
  "snooze",
  "unsnooze",
  "settle",
  "unsettle",
  "archive",
  "unarchive",
  "mark_unread",
] as const;
export type OrganizeAction = (typeof ORGANIZE_ACTIONS)[number];
const OrganizeActionSchema = Schema.Literals(ORGANIZE_ACTIONS);
const decodeOrganizeActionValue = Schema.decodeUnknownEffect(OrganizeActionSchema);

/** Settles, archives, pins, snoozes, or marks unread one thread. */
export const organizeThread = Effect.fn("cli.thread.organizeThread")(function* (
  tools: ThreadTools,
  input: {
    readonly threadId: ThreadId;
    readonly action: OrganizeAction;
    readonly snoozedUntil?: string;
  },
) {
  return yield* tools.call(
    "t3_thread_organize",
    {
      threadId: input.threadId,
      action: input.action,
      ...(input.snoozedUntil === undefined ? {} : { snoozedUntil: input.snoozedUntil }),
    },
    OrganizeThreadResult,
  );
});

/** Interrupts a thread's running turn; `stop` also holds its queue and tasks. */
export const interruptThread = Effect.fn("cli.thread.interruptThread")(function* (
  tools: ThreadTools,
  input: {
    readonly threadId: ThreadId;
    readonly runId?: RunId;
    readonly stop?: boolean;
    readonly reason?: string;
  },
) {
  return yield* tools.call(
    "t3_thread_interrupt",
    {
      threadId: input.threadId,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.stop === true ? { stop: true } : {}),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    },
    OrchestratorMcpThreadInterruptResult,
  );
});

/** Reads a thread's configuration, or switches its provider and model. */
export const configureThread = Effect.fn("cli.thread.configureThread")(function* (
  tools: ThreadTools,
  threadId: ThreadId,
  modelSelection?: { readonly instanceId: string; readonly model: string },
) {
  return yield* tools.call(
    "t3_thread_configure",
    { threadId, ...(modelSelection === undefined ? {} : { modelSelection }) },
    ThreadConfigureResult,
  );
});

/** The threads running on one branch, as `thread list --branch` filters them. */
export const threadsOnBranch = (
  threads: ReadonlyArray<OrchestratorMcpThreadListItem>,
  branch: string,
) => threads.filter((thread) => thread.branch === branch);

/**
 * The branch a thread runs on, for servers that predate the list field. Reads
 * look like a missing branch, so one stale thread cannot break a sweep.
 */
const readThreadBranch = Effect.fn("cli.thread.readThreadBranch")(function* (
  tools: ThreadTools,
  threadId: ThreadId,
) {
  return yield* tools
    .call("t3_thread_read", { threadId, limit: 1, runLimit: 1 }, OrchestratorMcpThreadReadResult)
    .pipe(
      Effect.map((page): string | null => page.thread.branch ?? null),
      Effect.orElseSucceed(() => null),
    );
});

/** `threadsOnBranch`, reading each thread when the server does not report branches. */
export const matchThreadsOnBranch = Effect.fn("cli.thread.matchThreadsOnBranch")(function* (
  tools: ThreadTools,
  threads: ReadonlyArray<OrchestratorMcpThreadListItem>,
  branch: string,
) {
  if (threads.every((thread) => thread.branch !== undefined)) {
    return threadsOnBranch(threads, branch);
  }
  const matches: Array<OrchestratorMcpThreadListItem> = [];
  for (const thread of threads) {
    if ((yield* readThreadBranch(tools, thread.threadId)) === branch) {
      matches.push({ ...thread, branch });
    }
  }
  return matches;
});

const ThreadPullRequest = Schema.Struct({
  host: Schema.String,
  repository: Schema.String,
  number: Schema.Int,
  url: Schema.String,
  source: Schema.String,
  watching: Schema.Boolean,
  state: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  headBranch: Schema.NullOr(Schema.String),
  baseBranch: Schema.NullOr(Schema.String),
  isDraft: Schema.NullOr(Schema.Boolean),
});
const ThreadPullRequestsResult = Schema.Struct({
  pullRequests: Schema.Array(ThreadPullRequest),
});

/** The pull requests linked to one thread, bottom of the stack first. */
export const readThreadPullRequests = Effect.fn("cli.thread.readThreadPullRequests")(function* (
  tools: ThreadTools,
  threadId: ThreadId,
) {
  return yield* tools.call(
    "list_thread_pull_requests",
    { threadId },
    ThreadPullRequestsResult,
  );
});

/** Renames a thread, the title the board uses to name ticket threads. */
export const renameThread = Effect.fn("cli.thread.renameThread")(function* (
  tools: ThreadTools,
  threadId: ThreadId,
  title: string,
) {
  return yield* tools.call(
    "t3_thread_update",
    { threadId, action: "rename", title },
    ThreadMetadataMcpUpdateResult,
  );
});

export type ThreadWaitOutcome =
  | {
      readonly type: "ended";
      readonly runId: RunId | null;
      readonly status: OrchestratorMcpThreadStatus;
    }
  | { readonly type: "needs_input" }
  | { readonly type: "deadline" };

/**
 * Waits for a thread's run to finish: the named run, else the newest one.
 * Without `timeoutMs` it waits as long as the run takes, in slices short
 * enough that a question the agent asks is noticed soon.
 */
export const waitForThread = Effect.fn("cli.thread.waitForThread")(function* (
  tools: ThreadTools,
  threadId: ThreadId,
  input: {
    readonly runId?: RunId;
    readonly timeoutMs?: number;
  },
) {
  const deadline =
    input.timeoutMs === undefined
      ? undefined
      : (yield* Clock.currentTimeMillis) + input.timeoutMs;
  const waitSlice = (timeoutMs: number) =>
    tools.call(
      "t3_thread_wait",
      {
        threadId,
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        timeoutMs,
      },
      OrchestratorMcpThreadWaitResult,
    );
  const ended = (waited: OrchestratorMcpThreadWaitResult) =>
    ({ type: "ended", runId: waited.runId, status: waited.status }) satisfies ThreadWaitOutcome;
  while (true) {
    const remaining =
      deadline === undefined
        ? undefined
        : Math.max(0, deadline - (yield* Clock.currentTimeMillis));
    if (remaining === 0) return { type: "deadline" } satisfies ThreadWaitOutcome;
    const waited = yield* waitSlice(
      remaining === undefined ? WAIT_SLICE_MS : Math.min(remaining, WAIT_SLICE_MS),
    );
    if (!waited.timedOut) return ended(waited);
    if (deadline !== undefined && (yield* Clock.currentTimeMillis) >= deadline) {
      return { type: "deadline" } satisfies ThreadWaitOutcome;
    }
    // A pending request blocks the run until someone answers; report it
    // instead of spending the deadline on it.
    const { thread } = yield* tools.call(
      "t3_thread_read",
      { threadId, limit: 1, runLimit: 1 },
      OrchestratorMcpThreadReadResult,
    );
    if (thread.pendingRequestCount > 0) {
      const recheck = yield* waitSlice(1);
      return recheck.timedOut
        ? ({ type: "needs_input" } satisfies ThreadWaitOutcome)
        : ended(recheck);
    }
  }
});

const titleFromMessage = (message: string) => {
  const firstLine = message.trim().split("\n")[0]?.trim() ?? "";
  return firstLine.length > TITLE_MAX_CHARS
    ? `${firstLine.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…`
    : firstLine;
};

const launchWorkspaceStrategy = (input: {
  readonly worktree: Option.Option<string>;
  readonly branch: Option.Option<string>;
}) =>
  Option.match(input.worktree, {
    onNone: () =>
      Option.isSome(input.branch)
        ? Effect.fail(new ThreadUsageError({ detail: "--branch needs --worktree <base-ref>." }))
        : Effect.void,
    onSome: (baseRef) =>
      Effect.succeed({
        type: "worktree" as const,
        baseRef,
        ...Option.match(input.branch, { onNone: () => ({}), onSome: (branch) => ({ branch }) }),
      }),
  });

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Print JSON instead of text."),
  Flag.withDefault(false),
);
const waitFlag = Flag.Boolean("wait").pipe(
  Flag.withDescription(
    "Wait for the agent to finish and print its reply. Exits 1 if the run fails and 2 if it waits for an answer.",
  ),
  Flag.withDefault(false),
);
const messageArgument = Argument.String("message").pipe(
  Argument.withDescription("Message for the agent, or - to read it from stdin."),
);
const threadArgument = Argument.String("thread").pipe(Argument.withDescription("Thread id."));

const decodeThreadIdValue = Schema.decodeUnknownEffect(ThreadId);
const decodeRunIdValue = Schema.decodeUnknownEffect(RunId);
const decodeRuntimeModeValue = Schema.decodeUnknownEffect(RuntimeMode);
const decodeTitle = Schema.decodeUnknownEffect(TrimmedNonEmptyString);
const decodeThreadId = (value: string) =>
  decodeThreadIdValue(value.trim()).pipe(
    Effect.mapError(() => new ThreadUsageError({ detail: `'${value}' is not a thread id.` })),
  );
const decodeRunId = (value: string) =>
  decodeRunIdValue(value.trim()).pipe(
    Effect.mapError(() => new ThreadUsageError({ detail: `'${value}' is not a run id.` })),
  );
const decodeRuntimeMode = (value: string) =>
  decodeRuntimeModeValue(value).pipe(
    Effect.mapError(
      () =>
        new ThreadUsageError({
          detail: `'${value}' is not a permission mode. Use approval-required, auto-accept-edits, auto, or full-access.`,
        }),
    ),
  );
const decodeOrganizeAction = (value: string) =>
  decodeOrganizeActionValue(value).pipe(
    Effect.mapError(
      () =>
        new ThreadUsageError({
          detail: `'${value}' is not an organize action. Use ${ORGANIZE_ACTIONS.join(", ")}.`,
        }),
    ),
  );

const threadListCommand = Command.make("list", {
  ...projectLocationFlags,
  project: Flag.String("project").pipe(
    Flag.withDescription("Project id or a path inside the project. Defaults to this directory."),
    Flag.withDefault("."),
  ),
  branch: Flag.String("branch").pipe(
    Flag.withDescription(
      "Only threads whose workspace branch matches. Each thread's workspace is read to find it.",
    ),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List a project's threads, newest first."),
  Command.withHandler((flags) =>
    withThreadTools(
      flags,
      Effect.fn("cli.thread.list")(function* (tools) {
        const project = yield* resolveProject(tools, flags.project);
        const threads: Array<OrchestratorMcpThreadListItem> = [];
        let cursor: number | null = 0;
        while (cursor !== null) {
          const page: OrchestratorMcpThreadListResult = yield* tools.call(
            "t3_thread_list",
            { projectId: project.id, includeSubagents: false, limit: 100, cursor },
            OrchestratorMcpThreadListResult,
          );
          threads.push(...page.threads);
          cursor = page.nextCursor;
        }
        if (Option.isNone(flags.branch)) {
          if (flags.json) {
            return yield* printJson(threads);
          }
          for (const thread of threads) {
            yield* Console.log(`${thread.threadId}  ${thread.status.padEnd(11)}  ${thread.title}`);
          }
          return;
        }
        const matches = yield* matchThreadsOnBranch(tools, threads, flags.branch.value);
        if (flags.json) {
          return yield* printJson(matches);
        }
        for (const thread of matches) {
          yield* Console.log(
            `${thread.threadId}  ${thread.status.padEnd(11)}  ${thread.branch ?? "(no branch)"}  ${thread.title}`,
          );
        }
      }),
    ).pipe(reportThreadErrors),
  ),
);

const threadStartCommand = Command.make("start", {
  ...projectLocationFlags,
  project: Argument.String("project").pipe(
    Argument.withDescription("Project id or a path inside the project, such as ."),
  ),
  message: messageArgument,
  title: Flag.String("title").pipe(
    Flag.withDescription("Thread title. Defaults to the message's first line."),
    Flag.optional,
  ),
  provider: Flag.String("provider").pipe(
    Flag.withDescription("Provider instance id. Pass with --model."),
    Flag.optional,
  ),
  model: Flag.String("model").pipe(
    Flag.withDescription("Model slug. Defaults to the project's default model."),
    Flag.optional,
  ),
  worktree: Flag.String("worktree").pipe(
    Flag.withDescription(
      "Run in a new git worktree based on this branch, tag, or commit, instead of the project folder.",
    ),
    Flag.optional,
  ),
  branch: Flag.String("branch").pipe(
    Flag.withDescription("Branch name for the new worktree."),
    Flag.optional,
  ),
  runtimeMode: Flag.String("runtime-mode").pipe(
    Flag.withDescription(
      "Permission mode for the thread: approval-required, auto-accept-edits, auto, or full-access. Defaults to the project's default.",
    ),
    Flag.optional,
  ),
  wait: waitFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Start a thread in a project and print its id."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const message = yield* readMessageArgument(flags.message);
      const workspaceStrategy = yield* launchWorkspaceStrategy(flags);
      const runtimeMode = Option.isSome(flags.runtimeMode)
        ? yield* decodeRuntimeMode(flags.runtimeMode.value)
        : undefined;
      if (Option.isSome(flags.provider) !== Option.isSome(flags.model)) {
        return yield* new ThreadUsageError({ detail: "--provider and --model go together." });
      }
      const title = yield* decodeTitle(
        Option.getOrElse(flags.title, () => titleFromMessage(message)),
      ).pipe(Effect.mapError(() => new ThreadUsageError({ detail: "The title is empty." })));
      yield* withThreadTools(
        flags,
        Effect.fn("cli.thread.start")(function* (tools) {
          const project = yield* resolveProject(tools, flags.project);
          const launched = yield* tools.call(
            "t3_thread_launch",
            {
              projectId: project.id,
              title,
              message,
              ...(workspaceStrategy === undefined ? {} : { workspaceStrategy }),
              ...(runtimeMode === undefined ? {} : { runtimeMode }),
              ...(Option.isSome(flags.provider) && Option.isSome(flags.model)
                ? {
                    modelSelection: {
                      instanceId: flags.provider.value,
                      model: flags.model.value,
                    },
                  }
                : {}),
            },
            ThreadLaunchResult,
          );
          if (flags.wait && launched.runId !== null) {
            if (!flags.json) yield* Console.error(`Thread ${launched.threadId}`);
            return yield* finishRun(tools, {
              threadId: launched.threadId,
              runId: launched.runId,
              json: flags.json,
            });
          }
          yield* flags.json ? printJson(launched) : Console.log(launched.threadId);
        }),
      );
    }).pipe(reportThreadErrors),
  ),
);

const threadSendCommand = Command.make("send", {
  ...projectLocationFlags,
  thread: threadArgument,
  message: messageArgument,
  restart: Flag.Boolean("restart").pipe(
    Flag.withDescription(
      "Interrupt the running turn and start over with this message instead of queueing it.",
    ),
    Flag.withDefault(false),
  ),
  wait: waitFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Send a message to a thread. A busy thread gets it as its next turn unless --restart is passed.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const threadId = yield* decodeThreadId(flags.thread);
      const message = yield* readMessageArgument(flags.message);
      yield* withThreadTools(
        flags,
        Effect.fn("cli.thread.send")(function* (tools) {
          const sent = yield* tools.call(
            "t3_thread_send",
            { threadId, message, mode: flags.restart ? "restart" : "queue" },
            OrchestratorMcpThreadSendResult,
          );
          if (flags.wait) {
            return yield* finishRun(tools, { threadId, runId: sent.runId, json: flags.json });
          }
          yield* flags.json
            ? printJson(sent)
            : Console.log(
                sent.delivery === "queued"
                  ? "Queued."
                  : sent.delivery === "restarted"
                    ? "Restarted."
                    : "Sent.",
              );
        }),
      );
    }).pipe(reportThreadErrors),
  ),
);

const threadShowCommand = Command.make("show", {
  ...projectLocationFlags,
  thread: threadArgument,
  messages: Flag.Int("messages").pipe(
    Flag.withDescription("How many of the latest messages to print."),
    Flag.withDefault(10),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show a thread's state and its latest messages."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const threadId = yield* decodeThreadId(flags.thread);
      yield* withThreadTools(
        flags,
        Effect.fn("cli.thread.show")(function* (tools) {
          const { thread, messages: latest } = yield* readLatestMessages(
            tools,
            threadId,
            flags.messages,
          );
          const messages = yield* Effect.forEach(latest, (item) =>
            readFullText(tools, threadId, item).pipe(
              Effect.map((text) => ({
                role: item.type === "user_message" ? "user" : "assistant",
                runId: item.runId,
                text,
              })),
            ),
          );
          if (flags.json) {
            return yield* printJson({ thread, messages });
          }
          yield* Console.log(thread.title);
          yield* Console.log(
            [thread.threadId, thread.status, `${thread.providerInstanceId}/${thread.model}`].join(
              "  ",
            ),
          );
          if (thread.worktreePath !== null) {
            yield* Console.log(`${thread.branch ?? "(no branch)"}  ${thread.worktreePath}`);
          }
          if (thread.pendingRequestCount > 0) {
            yield* Console.log(`Waiting for ${thread.pendingRequestCount} answer(s).`);
          }
          for (const entry of messages) {
            yield* Console.log(`\n[${entry.role}]\n${entry.text}`);
          }
        }),
      );
    }).pipe(reportThreadErrors),
  ),
);

const threadOrganizeCommand = Command.make("organize", {
  ...projectLocationFlags,
  thread: threadArgument,
  action: Argument.String("action").pipe(
    Argument.withDescription(`One of: ${ORGANIZE_ACTIONS.join(", ")}.`),
  ),
  snoozedUntil: Flag.String("snoozed-until").pipe(
    Flag.withDescription("ISO timestamp to snooze until. `snooze` needs it."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Pin, snooze, settle, archive, or mark a thread unread. Settling applies when its turn ends.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const threadId = yield* decodeThreadId(flags.thread);
      const action = yield* decodeOrganizeAction(flags.action);
      const snoozedUntil = Option.getOrUndefined(flags.snoozedUntil);
      if (action === "snooze" && snoozedUntil === undefined) {
        return yield* new ThreadUsageError({
          detail: "--snoozed-until <iso> is needed to snooze.",
        });
      }
      return yield* withThreadTools(
        flags,
        Effect.fn("cli.thread.organize")(function* (tools) {
          const result = yield* organizeThread(tools, {
            threadId,
            action,
            ...(snoozedUntil === undefined ? {} : { snoozedUntil }),
          });
          if (flags.json) {
            return yield* printJson(result);
          }
          yield* Console.log(
            "settlesWhenTurnEnds" in result && result.settlesWhenTurnEnds === true
              ? "The thread settles when its turn ends."
              : "Done.",
          );
        }),
      );
    }).pipe(reportThreadErrors),
  ),
);

const threadInterruptCommand = Command.make("interrupt", {
  ...projectLocationFlags,
  thread: threadArgument,
  stop: Flag.Boolean("stop").pipe(
    Flag.withDescription(
      "Stop the thread as its Stop button does: hold queued messages, end pull request watches, and stop every task it delegated.",
    ),
    Flag.withDefault(false),
  ),
  reason: Flag.String("reason").pipe(
    Flag.withDescription("Reason the run is being interrupted."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Interrupt a thread's running turn, newest run by default. No effect when idle."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const threadId = yield* decodeThreadId(flags.thread);
      const reason = Option.getOrUndefined(flags.reason);
      return yield* withThreadTools(
        flags,
        Effect.fn("cli.thread.interrupt")(function* (tools) {
          const result = yield* interruptThread(tools, {
            threadId,
            ...(flags.stop ? { stop: true } : {}),
            ...(reason === undefined ? {} : { reason }),
          });
          yield* flags.json
            ? printJson(result)
            : Console.log(`${result.threadId}  ${result.status}`);
        }),
      );
    }).pipe(reportThreadErrors),
  ),
);

const threadStopCommand = Command.make("stop", {
  ...projectLocationFlags,
  thread: threadArgument,
  reason: Flag.String("reason").pipe(
    Flag.withDescription("Reason the thread is being stopped."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Stop a thread as its Stop button does: interrupt the running turn, hold its queued messages, end pull request watches, and stop every task it delegated. Send a message to start it again.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const threadId = yield* decodeThreadId(flags.thread);
      const reason = Option.getOrUndefined(flags.reason);
      return yield* withThreadTools(
        flags,
        Effect.fn("cli.thread.stop")(function* (tools) {
          const result = yield* interruptThread(tools, {
            threadId,
            stop: true,
            ...(reason === undefined ? {} : { reason }),
          });
          yield* flags.json
            ? printJson(result)
            : Console.log(`${result.threadId}  ${result.status}`);
        }),
      );
    }).pipe(reportThreadErrors),
  ),
);

const threadConfigureCommand = Command.make("configure", {
  ...projectLocationFlags,
  thread: threadArgument,
  provider: Flag.String("provider").pipe(
    Flag.withDescription("Provider instance id. Pass with --model."),
    Flag.optional,
  ),
  model: Flag.String("model").pipe(
    Flag.withDescription("Model slug to switch the thread to. Pass with --provider."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Read a thread's provider, model, and modes, or switch its provider and model.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const threadId = yield* decodeThreadId(flags.thread);
      if (Option.isSome(flags.provider) !== Option.isSome(flags.model)) {
        return yield* new ThreadUsageError({ detail: "--provider and --model go together." });
      }
      return yield* withThreadTools(
        flags,
        Effect.fn("cli.thread.configure")(function* (tools) {
          const result = yield* configureThread(
            tools,
            threadId,
            Option.isSome(flags.provider) && Option.isSome(flags.model)
              ? { instanceId: flags.provider.value, model: flags.model.value }
              : undefined,
          );
          if (flags.json) {
            return yield* printJson(result);
          }
          if ("modelSelection" in result) {
            yield* Console.log(
              [
                result.threadId,
                `${result.modelSelection.instanceId}/${result.modelSelection.model}`,
                result.runtimeMode,
                result.interactionMode,
              ].join("  "),
            );
            return;
          }
          yield* Console.log(`Set ${threadId}'s model.`);
        }),
      );
    }).pipe(reportThreadErrors),
  ),
);

const threadWaitCommand = Command.make("wait", {
  ...projectLocationFlags,
  thread: threadArgument,
  run: Flag.String("run").pipe(
    Flag.withDescription("Run id to wait for. Defaults to the thread's newest run."),
    Flag.optional,
  ),
  timeout: Flag.Int("timeout").pipe(
    Flag.withDescription(
      "Give up after this many milliseconds and exit 3. Defaults to waiting as long as the run takes.",
    ),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Wait for a thread's run to finish and print its reply. Exits 1 if the run fails and 2 if it waits for an answer.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const threadId = yield* decodeThreadId(flags.thread);
      const runIdValue = Option.getOrUndefined(flags.run);
      const runId = runIdValue === undefined ? undefined : yield* decodeRunId(runIdValue);
      const timeoutMs = Option.getOrUndefined(flags.timeout);
      return yield* withThreadTools(
        flags,
        Effect.fn("cli.thread.wait")(function* (tools) {
          const outcome = yield* waitForThread(tools, threadId, {
            ...(runId === undefined ? {} : { runId }),
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
          });
          if (outcome.type === "ended") {
            const report = yield* reportRun(tools, {
              threadId,
              runId: outcome.runId,
              status: outcome.status,
              json: flags.json,
            });
            if (outcome.status !== "completed") {
              return yield* new ThreadRunEndedError({
                threadId,
                status: outcome.status,
                ...(report.error === null ? {} : { error: report.error }),
              });
            }
            return;
          }
          if (outcome.type === "needs_input") {
            if (flags.json) {
              yield* printJson({
                threadId,
                runId: runId ?? null,
                status: "waiting",
                reply: null,
                error: null,
              });
            }
            return yield* new ThreadNeedsInputError({ threadId });
          }
          if (flags.json) {
            yield* printJson({
              threadId,
              runId: runId ?? null,
              status: "running",
              reply: null,
              error: null,
            });
          }
          return yield* new ThreadDeadlineError({ threadId, timeoutMs: timeoutMs ?? 0 });
        }),
      );
    }).pipe(reportThreadErrors),
  ),
);

const threadPullRequestsCommand = Command.make("prs", {
  ...projectLocationFlags,
  thread: threadArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List the pull requests linked to a thread, bottom of the stack first."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const threadId = yield* decodeThreadId(flags.thread);
      return yield* withThreadTools(
        flags,
        Effect.fn("cli.thread.prs")(function* (tools) {
          const result = yield* readThreadPullRequests(tools, threadId);
          if (flags.json) {
            return yield* printJson(result);
          }
          if (result.pullRequests.length === 0) {
            yield* Console.log("No pull requests are linked.");
            return;
          }
          for (const pullRequest of result.pullRequests) {
            yield* Console.log(
              [
                pullRequest.state ?? "unknown",
                `#${pullRequest.number}`,
                pullRequest.title ?? pullRequest.repository,
                pullRequest.url,
              ].join("  "),
            );
          }
        }),
      );
    }).pipe(reportThreadErrors),
  ),
);

const threadRenameCommand = Command.make("rename", {
  ...projectLocationFlags,
  thread: threadArgument,
  title: Argument.String("title").pipe(Argument.withDescription("New thread title.")),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Rename a thread."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const threadId = yield* decodeThreadId(flags.thread);
      const title = yield* decodeTitle(flags.title).pipe(
        Effect.mapError(() => new ThreadUsageError({ detail: "The title is empty." })),
      );
      return yield* withThreadTools(
        flags,
        Effect.fn("cli.thread.rename")(function* (tools) {
          const result = yield* renameThread(tools, threadId, title);
          yield* flags.json ? printJson(result) : Console.log(`Renamed to ${result.title}.`);
        }),
      );
    }).pipe(reportThreadErrors),
  ),
);

export const threadCommand = Command.make("thread").pipe(
  Command.withDescription("Start, message, and read threads on the running server."),
  Command.withSubcommands([
    threadListCommand,
    threadStartCommand,
    threadSendCommand,
    threadShowCommand,
    threadOrganizeCommand,
    threadInterruptCommand,
    threadStopCommand,
    threadConfigureCommand,
    threadWaitCommand,
    threadPullRequestsCommand,
    threadRenameCommand,
  ]),
);
