import { OrchestratorMcpCapabilitiesResult } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/cli";

import { projectLocationFlags } from "./config.ts";
import { printJson, reportThreadErrors, withThreadTools, type ThreadTools } from "./thread.ts";

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Print JSON instead of text."),
  Flag.withDefault(false),
);

/** Providers and models this environment may launch or switch a thread to. */
export const readCapabilities = Effect.fn("cli.models.readCapabilities")(function* (
  tools: ThreadTools,
  search?: string,
) {
  return yield* tools.call(
    "orchestrator_capabilities",
    search === undefined ? {} : { search },
    OrchestratorMcpCapabilitiesResult,
  );
});

/** One provider per heading, one line per model under it. */
export const formatModels = (capabilities: OrchestratorMcpCapabilitiesResult) =>
  capabilities.providers
    .flatMap((provider) => [
      `${provider.providerInstanceId}  ${provider.displayName ?? ""}`.trimEnd(),
      ...provider.models.map((model) => `  ${model.id}`),
      ...(provider.omittedModels === undefined
        ? []
        : [`  (${provider.omittedModels} more; pass --search)`]),
    ])
    .join("\n");

export const modelsCommand = Command.make("models", {
  ...projectLocationFlags,
  search: Flag.String("search").pipe(
    Flag.withDescription("Match model ids and labels, past the short default list."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "List the providers and models this environment may launch or switch a thread to.",
  ),
  Command.withHandler((flags) =>
    withThreadTools(
      flags,
      Effect.fn("cli.models.list")(function* (tools) {
        const search = Option.getOrUndefined(flags.search);
        const capabilities = yield* readCapabilities(tools, search);
        if (flags.json) {
          return yield* printJson(capabilities);
        }
        yield* Console.log(formatModels(capabilities));
      }),
    ).pipe(reportThreadErrors),
  ),
);
