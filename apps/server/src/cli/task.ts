import { OrchestratorMcpTaskCancelResult } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Argument, Command, Flag } from "effect/cli";

import { projectLocationFlags } from "./config.ts";
import { printJson, reportThreadErrors, withThreadTools } from "./thread.ts";

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Print JSON instead of text."),
  Flag.withDefault(false),
);

const taskCancelCommand = Command.make("cancel", {
  ...projectLocationFlags,
  task: Argument.String("task").pipe(Argument.withDescription("Delegated task id.")),
  reason: Flag.String("reason").pipe(
    Flag.withDescription("Reason the task is being cancelled."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Cancel a delegated task: its running and queued turns, its delegates, and its pull request watches.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const reason = Option.getOrUndefined(flags.reason);
      return yield* withThreadTools(
        flags,
        Effect.fn("cli.task.cancel")(function* (tools) {
          // The server scopes this tool to the thread that started the task, so
          // an outside client normally runs `t3 thread interrupt --stop` instead.
          const result = yield* tools.call(
            "task_cancel",
            { taskId: flags.task.trim(), ...(reason === undefined ? {} : { reason }) },
            OrchestratorMcpTaskCancelResult,
          );
          if (flags.json) {
            return yield* printJson(result);
          }
          yield* Console.log(`${result.taskId}  ${result.status}`);
        }),
      );
    }).pipe(reportThreadErrors),
  ),
);

export const taskCommand = Command.make("task").pipe(
  Command.withDescription("Manage delegated tasks on the running server."),
  Command.withSubcommands([taskCancelCommand]),
);
