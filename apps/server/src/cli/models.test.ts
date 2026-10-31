import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { formatModels, readCapabilities } from "./models.ts";
import type { ThreadTools } from "./thread.ts";

const capabilities = {
  parentThreadId: null,
  inheritedProviderInstanceId: null,
  inheritedModel: null,
  runtimeMode: "full-access",
  interactionMode: "default",
  providers: [
    {
      providerInstanceId: "claudeAgent",
      driverKind: "claude",
      displayName: "Claude",
      models: [{ id: "claude-opus-5-5" }, { id: "claude-sonnet-4-5" }],
      canRunChildTask: true,
      canRunCrossProviderChildTask: false,
      constraints: [],
    },
    {
      providerInstanceId: "codex",
      driverKind: "codex",
      displayName: null,
      models: [{ id: "gpt-6.1-sol" }],
      omittedModels: 4,
      canRunChildTask: true,
      canRunCrossProviderChildTask: true,
      constraints: [],
    },
  ],
  features: {
    appOwnedSubagents: true,
    asyncPolling: true,
    cancellation: true,
    batchThreadCreation: true,
    threadManagement: true,
    incrementalThreadRead: true,
    scheduledTasks: true,
    maxBatchThreads: 8,
  },
} as unknown as typeof import("@t3tools/contracts").OrchestratorMcpCapabilitiesResult.Type;

const scriptedTools = (response: unknown) => {
  const calls: Array<{ readonly tool: string; readonly args: unknown }> = [];
  const call = ((tool: string, args: unknown) => {
    calls.push({ tool, args });
    return Effect.succeed(response);
  }) as ThreadTools["call"];
  return {
    tools: { call, callRaw: call, listTools: () => Effect.die("unscripted tools/list") } as unknown as ThreadTools,
    calls,
  };
};

it.effect("models reads the capabilities with and without a search", () =>
  Effect.gen(function* () {
    const { tools, calls } = scriptedTools(capabilities);

    yield* readCapabilities(tools);
    yield* readCapabilities(tools, "opus");

    assert.deepStrictEqual(calls, [
      { tool: "orchestrator_capabilities", args: {} },
      { tool: "orchestrator_capabilities", args: { search: "opus" } },
    ]);
  }),
);

it.effect("models prints one heading per provider and one line per model", () =>
  Effect.sync(() => {
    assert.strictEqual(
      formatModels(capabilities),
      [
        "claudeAgent  Claude",
        "  claude-opus-5-5",
        "  claude-sonnet-4-5",
        "codex",
        "  gpt-6.1-sol",
        "  (4 more; pass --search)",
      ].join("\n"),
    );
  }),
);
