import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { listAllTools, parseToolArguments, toolResultText } from "./mcp.ts";
import { ThreadUsageError, type ThreadTools } from "./thread.ts";

const scriptedPages = (pages: ReadonlyArray<{ tools: Array<{ name: string }>; nextCursor?: string }>) => {
  const cursors: Array<string | undefined> = [];
  const listTools = ((cursor?: string) => {
    cursors.push(cursor);
    const page = pages[cursors.length - 1];
    return page === undefined ? Effect.die("unscripted tools/list") : Effect.succeed(page);
  }) as ThreadTools["listTools"];
  return { tools: { listTools } as unknown as ThreadTools, cursors };
};

const layerStdio = NodeServices.layer.pipe(Layer.orDie);

it.effect("reads tool arguments as a JSON object", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* parseToolArguments('{"limit": 100}'), { limit: 100 });
  }).pipe(Effect.provide(layerStdio)),
);

it.effect("treats empty arguments as none", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* parseToolArguments("  "), {});
  }).pipe(Effect.provide(layerStdio)),
);

it.effect("refuses arguments that are not one JSON object", () =>
  Effect.gen(function* () {
    const notAnObject = yield* Effect.flip(parseToolArguments("[1, 2]"));
    const notJson = yield* Effect.flip(parseToolArguments("nope"));

    assert.instanceOf(notAnObject, ThreadUsageError);
    assert.instanceOf(notJson, ThreadUsageError);
  }).pipe(Effect.provide(layerStdio)),
);

it.effect("lists every tool page and stops on a repeated cursor", () =>
  Effect.gen(function* () {
    const { tools, cursors } = scriptedPages([
      { tools: [{ name: "t3_thread_list" }], nextCursor: "page-2" },
      { tools: [{ name: "t3_project_list" }], nextCursor: "page-2" },
    ]);

    const listed = yield* listAllTools(tools);

    assert.deepStrictEqual(
      listed.map((tool) => tool.name),
      ["t3_thread_list", "t3_project_list"],
    );
    assert.deepStrictEqual(cursors, [undefined, "page-2"]);
  }),
);

it.effect("prints structured content before text parts", () =>
  Effect.sync(() => {
    assert.strictEqual(
      toolResultText({
        structuredContent: { threads: [] },
        content: [{ type: "text", text: "ignored" }],
      }),
      '{"threads":[]}',
    );
    assert.strictEqual(
      toolResultText({ content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] }),
      "first\nsecond",
    );
    assert.strictEqual(toolResultText({}), "");
  }),
);
