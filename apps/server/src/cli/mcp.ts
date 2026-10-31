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
const decodeJsonValue = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
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

/** `--arg key=value` entries, with JSON values when they parse and text otherwise. */
export const parseArgPairs = Effect.fn("cli.mcp.parseArgPairs")(function* (
  pairs: ReadonlyArray<string>,
  into: Readonly<Record<string, unknown>>,
) {
  const merged: Record<string, unknown> = { ...into };
  for (const pair of pairs) {
    const separator = pair.indexOf("=");
    if (separator <= 0) {
      return yield* new ThreadUsageError({
        detail: `'${pair}' is not a --arg key=value pair.`,
      });
    }
    const key = pair.slice(0, separator).trim();
    const raw = pair.slice(separator + 1);
    merged[key] = Option.match(decodeJsonValue(raw), {
      onNone: () => raw,
      onSome: (value) => value,
    });
  }
  return merged;
});

interface ToolParameter {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly description?: string;
}

/** The parameters a tool's JSON Schema declares, in declared order. */
export const toolParameters = (tool: McpToolDescription): ReadonlyArray<ToolParameter> => {
  const schema = tool.inputSchema as
    | {
        properties?: Record<string, { type?: unknown; description?: unknown }>;
        required?: Array<string>;
      }
    | undefined;
  const properties = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  const typeOf = (property: { type?: unknown } | undefined) =>
    Array.isArray(property?.type)
      ? property.type.join(" | ")
      : typeof property?.type === "string"
        ? property.type
        : "any";
  return Object.entries(properties).map(([name, property]) => ({
    name,
    type: typeOf(property),
    required: required.has(name),
    ...(typeof property?.description === "string" && property.description.length > 0
      ? { description: firstLine(property.description) }
      : {}),
  }));
};

/** Refuses a call the tool's schema already shows is missing required arguments. */
export const validateToolArguments = (
  tool: McpToolDescription,
  args: Readonly<Record<string, unknown>>,
) => {
  const missing = toolParameters(tool)
    .filter((parameter) => parameter.required && args[parameter.name] === undefined)
    .map((parameter) => parameter.name);
  return missing.length === 0
    ? Effect.succeed(args)
    : Effect.fail(
        new ThreadUsageError({
          detail: `${tool.name} needs ${missing.join(", ")}. Run: t3 mcp describe ${tool.name}`,
        }),
      );
};

export const describeTool = (tool: McpToolDescription) => {
  const parameters = toolParameters(tool);
  const lines = [
    tool.name,
    ...(tool.description === undefined ? [] : [`  ${tool.description}`]),
    "",
    parameters.length === 0 ? "  Takes no arguments." : "Arguments:",
    ...parameters.map(
      (parameter) =>
        `  ${parameter.name}  ${parameter.type}${parameter.required ? "  required" : ""}${
          parameter.description === undefined ? "" : `  ${parameter.description}`
        }`,
    ),
  ];
  return lines.join("\n");
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

const mcpDescribeCommand = Command.make("describe", {
  ...projectLocationFlags,
  tool: Argument.String("tool").pipe(
    Argument.withDescription("Tool name, as `t3 mcp list` prints it."),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show one MCP tool's arguments and what each one means."),
  Command.withHandler((flags) =>
    withThreadTools(
      flags,
      Effect.fn("cli.mcp.describe")(function* (tools) {
        const tool = (yield* listAllTools(tools)).find((entry) => entry.name === flags.tool);
        if (tool === undefined) {
          return yield* new ThreadUsageError({
            detail: `No MCP tool named '${flags.tool}'. Run: t3 mcp list --filter ${flags.tool}`,
          });
        }
        if (flags.json) {
          return yield* printJson(tool);
        }
        yield* Console.log(describeTool(tool));
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
  arg: Flag.String("arg").pipe(
    Flag.withDescription("One key=value argument, repeated once per argument. Overrides the JSON."),
    Flag.atLeast(0),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Call one MCP tool with JSON arguments and print its result."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const parsed = yield* parseToolArguments(Option.getOrElse(flags.arguments, () => "{}"));
      const args = yield* parseArgPairs(flags.arg, parsed);
      return yield* withThreadTools(
        flags,
        Effect.fn("cli.mcp.call")(function* (tools) {
          const tool = (yield* listAllTools(tools)).find((entry) => entry.name === flags.tool);
          if (tool === undefined) {
            return yield* new ThreadUsageError({
              detail: `No MCP tool named '${flags.tool}'. Run: t3 mcp list --filter ${flags.tool}`,
            });
          }
          const valid = yield* validateToolArguments(tool, args);
          const result = yield* tools.callRaw(flags.tool, valid);
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
  Command.withDescription("List, describe, and call the MCP tools of the running server."),
  Command.withSubcommands([mcpListCommand, mcpDescribeCommand, mcpCallCommand]),
);
