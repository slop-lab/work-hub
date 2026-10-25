import type { Actor } from "../domain/authorization.ts";
import type { HubCommand } from "../domain/commands.ts";
import type { OperationStatus } from "../domain/model.ts";

export type CommandOf<T extends HubCommand["type"]> = Extract<HubCommand, { readonly type: T }>;

export type CommandResult = {
  readonly status: OperationStatus;
  readonly confirmedEffect?: string;
  readonly objectRefs: readonly {
    readonly kind: string;
    readonly id: string;
    readonly revision?: number;
  }[];
  readonly operationIds: readonly string[];
};

export type HandlerInput<C extends HubCommand> = {
  readonly actor: Actor;
  readonly command: C;
};
