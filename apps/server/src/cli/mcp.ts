import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag } from "effect/cli";

import type { McpToolDescription } from "../mcp/AcpMcpStdioBridge.ts";
import { projectLocationFlags } from "./config.ts";
import {
  printJson,
  reportThreadErrors,
  ThreadUsageError,
  withThreadTools,
  type ThreadTools,
} from "./thread.ts";

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Print JSON instead of text."),
  Flag.withDefault(false),
);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeToolArguments = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/** Tool arguments as an object, from JSON or `-` for stdin. */
export const parseToolArguments = Effect.fn("cli.mcp.parseToolArguments")(function* (raw: string) {
  const text =
    raw === "-"
      ? yield* Stdio.Stdio.pipe(
          Effect.flatMap((stdio) => stdio.stdin.pipe(Stream.decodeText(), Stream.mkString)),
        )
      : raw;
  if (text.trim().length === 0) return {};
  return yield* decodeToolArguments(text).pipe(
    Effect.mapError(
      () =>
        new ThreadUsageError({
          detail: "Tool arguments must be one JSON object, such as '{\"limit\": 100}'.",
        }),
    ),
  );
});

/** Every tool the session may call, oldest page first. */
export const listAllTools = Effect.fn("cli.mcp.listAllTools")(function* (tools: ThreadTools) {
  const all: Array<McpToolDescription> = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = yield* tools.listTools(cursor);
    all.push(...page.tools);
    // A server that repeats a cursor would otherwise loop forever.
    if (page.nextCursor !== undefined && seen.has(page.nextCursor)) break;
    if (page.nextCursor !== undefined) seen.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return all;
});

/** Structured content when a tool returns it, else its text parts. */
export const toolResultText = (result: {
  readonly structuredContent?: unknown;
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string | undefined }> | undefined;
}) => {
  if (result.structuredContent !== undefined) return encodeJson(result.structuredContent);
  return (result.content ?? [])
    .map((part) => part.text ?? "")
    .filter((text) => text.length > 0)
    .join("\n");
};

const firstLine = (text: string) => text.trim().split("\n")[0]?.trim() ?? "";

const mcpListCommand = Command.make("list", {
  ...projectLocationFlags,
  filter: Flag.String("filter").pipe(
    Flag.withDescription("Only tools whose name or description contains this text."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List the MCP tools this script may call on the running server."),
  Command.withHandler((flags) =>
    withThreadTools(
      flags,
      Effect.fn("cli.mcp.list")(function* (tools) {
        const all = yield* listAllTools(tools);
        const filter = Option.getOrUndefined(flags.filter)?.toLowerCase();
        const matching =
          filter === undefined
            ? all
            : all.filter(
                (tool) =>
                  tool.name.toLowerCase().includes(filter) ||
                  (tool.description ?? "").toLowerCase().includes(filter),
              );
        if (flags.json) {
          return yield* printJson(matching);
        }
        for (const tool of matching) {
          yield* Console.log(`${tool.name}  ${firstLine(tool.description ?? "")}`);
        }
      }),
    ).pipe(reportThreadErrors),
  ),
);

const mcpCallCommand = Command.make("call", {
  ...projectLocationFlags,
  tool: Argument.String("tool").pipe(
    Argument.withDescription("Tool name, as `t3 mcp list` prints it."),
  ),
  arguments: Argument.String("arguments").pipe(
    Argument.withDescription(
      "Arguments as one JSON object, or - to read them from stdin. Defaults to none.",
    ),
    Argument.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Call one MCP tool with JSON arguments and print its result."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const args = yield* parseToolArguments(Option.getOrElse(flags.arguments, () => "{}"));
      return yield* withThreadTools(
        flags,
        Effect.fn("cli.mcp.call")(function* (tools) {
          const result = yield* tools.callRaw(flags.tool, args);
          if (flags.json) {
            return yield* printJson(result);
          }
          const text = toolResultText(result);
          if (text.length > 0) yield* Console.log(text);
        }),
      );
    }).pipe(reportThreadErrors),
  ),
);

export const mcpCommand = Command.make("mcp").pipe(
  Command.withDescription("List and call the MCP tools of the running server."),
  Command.withSubcommands([mcpListCommand, mcpCallCommand]),
);
