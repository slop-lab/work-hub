import { z } from "zod";

import { HubError } from "./errors.ts";
import { executionCommandSchemas } from "./execution-commands.ts";
import { interactionCommandSchemas } from "./interaction-commands.ts";
import { lifecycleCommandSchemas } from "./lifecycle-commands.ts";
import { workCommandSchemas } from "./work-commands.ts";

export const hubCommandSchema = z.discriminatedUnion("type", [
  ...workCommandSchemas,
  ...interactionCommandSchemas,
  ...lifecycleCommandSchemas,
  ...executionCommandSchemas,
]);

export type HubCommand = z.infer<typeof hubCommandSchema>;

export function parseHubCommand(input: unknown): HubCommand {
  const parsed = hubCommandSchema.safeParse(input);
  if (!parsed.success) {
    throw new HubError({
      code: "invalid_command",
      category: "validation",
      message: z.prettifyError(parsed.error),
      retry: "never",
    });
  }
  return parsed.data;
}

export function commandTargetId(command: HubCommand, kind: string): string {
  if (command.target?.kind !== kind) {
    throw new HubError({
      code: "invalid_target",
      category: "validation",
      message: `Command ${command.type} requires target kind ${kind}.`,
      retry: "never",
    });
  }
  return command.target.id;
}
