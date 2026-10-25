import type { AgentRuntimeConnector, ExecutionConnector } from "../contracts/index.ts";
import { HubError } from "../domain/errors.ts";
import { CapabilitySchema, ConnectorManifestSchema } from '../contracts/index.ts';

export type ConnectorSet = {
  readonly execution: Readonly<Record<string, ExecutionConnector>>;
  readonly runtime: Readonly<Record<string, AgentRuntimeConnector>>;
};

export class ConnectorRegistry {
  private readonly connectors: ConnectorSet;

  constructor(connectors: ConnectorSet) {
    this.connectors = connectors;
  }

  execution(installationId: string): ExecutionConnector {
    const connector = this.connectors.execution[installationId];
    if (connector === undefined) {
      throw new HubError({
        code: "connector_unavailable", category: "unavailable",
        message: `Execution connector ${installationId} is not configured.`, retry: "manual_action",
      });
    }
    return connector;
  }

  runtime(installationId: string): AgentRuntimeConnector {
    const connector = this.connectors.runtime[installationId];
    if (connector === undefined) {
      throw new HubError({
        code: "connector_unavailable", category: "unavailable",
        message: `Runtime connector ${installationId} is not configured.`, retry: "manual_action",
      });
    }
    return connector;
  }

  runtimeSupports(installationId: string, names: readonly string[]): boolean {
    const description = this.runtime(installationId).describe();
    ConnectorManifestSchema.parse(description.manifest);
    return names.every((name) => {
      const capability = CapabilitySchema.safeParse(Reflect.get(description.capabilities, name));
      return capability.success && capability.data.support === 'supported';
    });
  }
}
