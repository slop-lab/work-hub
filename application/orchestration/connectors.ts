import type { AgentRuntimeConnector, ExecutionConnector } from "../contracts/index.ts";
import { HubError } from "../domain/errors.ts";
import { CapabilitySchema, ConnectorManifestSchema, RuntimeCapabilitiesSchema } from '../contracts/index.ts';
import { executionBoundary, runtimeBoundary } from './connector-boundary.ts';

export type ConnectorSet = {
  readonly execution: Readonly<Record<string, ExecutionConnector>>;
  readonly runtime: Readonly<Record<string, AgentRuntimeConnector>>;
};

export class ConnectorRegistry {
  private readonly connectors: ConnectorSet;

  constructor(connectors: ConnectorSet) {
    this.connectors = {
      execution: Object.fromEntries(Object.entries(connectors.execution).map(([id, connector]) => [id, executionBoundary(connector)])),
      runtime: Object.fromEntries(Object.entries(connectors.runtime).map(([id, connector]) => [id, runtimeBoundary(connector)])),
    };
  }

  available(kind: 'execution' | 'agent_runtime', installationId: string): boolean {
    const connector = kind === 'execution' ? this.connectors.execution[installationId] : this.connectors.runtime[installationId];
    if (connector === undefined) return false;
    const description = connector.describe();
    const manifest = ConnectorManifestSchema.safeParse('manifest' in description ? description.manifest : description);
    if (!manifest.success || manifest.data.kind !== kind) return false;
    return kind === 'execution' || ('capabilities' in description && RuntimeCapabilitiesSchema.safeParse(description.capabilities).success);
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
