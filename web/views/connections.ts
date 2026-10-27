import { commandId } from '../api.ts';
import { button, el, label, submitButton } from '../dom.ts';
import { loadIntegrations, type IntegrationInventory } from '../integrations.ts';
import type { UiContext } from '../ui-context.ts';

const inventoryByUser = new Map<string, IntegrationInventory>();
export function clearConnectionInventory(): void { inventoryByUser.clear(); }

export function connectionsPanel(ctx: UiContext): HTMLElement {
  const content = el('div', { class: 'stack' }, 'Discover saved, backend-scoped connections. No agent starts during discovery.');
  const renderInventory = (inventory: IntegrationInventory) => {
    content.replaceChildren(...inventory.runtime.map((item) => runtimeRow(ctx, item)), ...inventory.execution.map((item) => environmentRow(ctx, item)));
    if (!inventory.runtime.length && !inventory.execution.length) content.textContent = 'No external connections configured. Ask the operator to install a private scoped connection file; do not paste credentials here.';
  };
  const cached = inventoryByUser.get(ctx.state.me.id);
  if (cached) renderInventory(cached);
  const refresh = button('Discover connections', 'secondary', () => {
    refresh.disabled = true;
    content.textContent = 'Checking saved connections…';
    void loadIntegrations().then((inventory) => {
      inventoryByUser.set(ctx.state.me.id, inventory);
      renderInventory(inventory);
    }).catch((error: unknown) => { content.textContent = error instanceof Error ? 'Discovery failed. Check your sign-in and ask the operator to verify the saved connections.' : 'Discovery failed.';
    }).finally(() => { refresh.disabled = false; });
  });
  return el('section', { class: 'detail-section' }, el('header', { class: 'section-heading cluster' }, el('h2', {}, 'Saved service connections'), refresh), content);
}

async function register(ctx: UiContext, connection: { readonly installationId: string; readonly label: string }, kind: 'agent_runtime' | 'execution'): Promise<boolean> {
  if (ctx.state.installations.some((item) => item.id === connection.installationId)) return true;
  return ctx.command({ commandId: commandId(), type: 'installation.create', payload: {
    id: connection.installationId, label: connection.label, kind, contractMajor: 1, implementation: 'configured',
  } }, 'Scoped connector registered. No runtime or environment started.');
}
function runtimeRow(ctx: UiContext, connection: IntegrationInventory['runtime'][number]): HTMLElement {
  const providerLabel = connection.kind === 'opencode' ? 'OpenCode' : connection.kind === 'claude-code' ? 'Claude Code' : 'Codex CLI';
  const row = el('article', { class: 'profile-row' }, el('div', {}, el('h3', {}, connection.label), el('span', { class: 'muted' }, providerLabel)));
  if (connection.status === 'unavailable') { row.append(el('p', { class: 'limitation' }, `${connection.error.code}: ${connection.error.message}`)); return row; }
  const value = connection.value;
  const agent = el('select', { class: 'select', name: 'runtime-agent', required: true }, el('option', { value: '' }, 'Choose a runtime profile'), ...value.agents.map((name) => el('option', { value: name }, name)));
  const model = connection.kind === 'claude-code'
    ? el('input', { class: 'input', name: 'runtime-model', required: true, placeholder: 'Provider model ID', autocomplete: 'off' })
    : el('select', { class: 'select', name: 'runtime-model', required: true }, el('option', { value: '' }, 'Choose a model'), ...value.models.map((item, index) => el('option', { value: String(index) }, `${item.providerID}/${item.modelID}`)));
  const project = el('select', { class: 'select', name: 'runtime-project', required: true }, el('option', { value: '' }, 'Choose a Work Hub project'), ...ctx.state.projects.map((item) => el('option', { value: item.id }, item.name)));
  const environment = el('select', { class: 'select', name: 'runtime-environment' }, ...ctx.state.environments.filter((item) =>
    item.executionInstallationId === value.environment?.executionInstallationId && item.retiredAt === undefined)
    .map((item) => el('option', { value: item.id }, item.label)));
  const submit = submitButton('Save execution profile');
  const syncSubmit = (): void => { submit.disabled = agent.value.length === 0 || model.value.length === 0 || project.value.length === 0 || (value.environment !== null && environment.options.length === 0); };
  agent.addEventListener('change', syncSubmit);
  model.addEventListener('change', syncSubmit);
  project.addEventListener('change', syncSubmit);
  const form = el('form', { class: 'stack' }, label('Runtime profile', agent, `Select the ${providerLabel} profile deliberately; no profile is chosen automatically.`),
    label(connection.kind === 'claude-code' ? 'Model ID' : 'Connected model', model, connection.kind === 'claude-code' ? 'Enter the provider model identifier deliberately. Work Hub does not claim a native model catalog for Claude Code.' : 'Select the model deliberately; provider availability is reported by the saved connection.'), label('Work Hub project', project),
    value.environment === null ? null : label('Mapped DIM registration', environment, 'Register the mapped environment first. Environment-free work cannot bypass its use grant.'),
    el('p', { class: 'muted' }, 'Saving a profile sends no prompt. Delegate from a task to deliberately create a session, or attach a discovered session below.'), submit);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const selected = connection.kind === 'claude-code' ? undefined : value.models[Number(model.value)];
    if (connection.kind !== 'claude-code' && selected === undefined) return;
    const registration = ctx.state.environments.find((item) => item.id === environment.value);
    const defaultEnvironment = value.environment === null ? { mode: 'none' } : registration ? {
      mode: 'existing', registrationId: registration.id, expectedRegistrationRevision: registration.revision,
      requestedAccess: registration.workAreas.some((area) => area.requestedAccess === 'write') ? 'write' : 'read',
      workAreas: registration.workAreas.map((area) => ({ ...area, preparation: 'preserve_existing' })),
    } : undefined;
    if (!defaultEnvironment) return;
    const providerProfile = (() => {
      switch (connection.kind) {
        case 'opencode':
          return { configuration: { agent: agent.value, model: selected, projectId: project.value }, requiredCapabilities: ['createSession', 'structuredInput'] };
        case 'codex':
          return { configuration: { agent: 'codex', model: selected, projectId: project.value }, requiredCapabilities: ['createSession', 'structuredInput'] };
        case 'claude-code':
          return { configuration: { model: model.value }, requiredCapabilities: ['attachSession', 'structuredInput'] };
        default:
          return connection.kind satisfies never;
      }
    })();
    void (async () => {
      if (!await register(ctx, connection, 'agent_runtime')) return;
      await ctx.command({ commandId: commandId(), type: 'profile.create', payload: {
        label: `${connection.label}: ${agent.value}`, runtimeInstallationId: connection.installationId,
        configuration: providerProfile.configuration,
        allowedEnvironmentModes: value.environment === null ? ['none'] : ['existing'], defaultEnvironment,
        requiredCapabilities: providerProfile.requiredCapabilities, allowedEffects: ['task.read', 'work.write'],
      } }, 'Execution profile saved. Select it during task delegation.');
    })();
  });
  syncSubmit();
  row.append(el('p', { class: 'mono' }, `${connection.installationId} / ${providerLabel} ${value.version} / ${value.directory}`), ...value.limitations.map((text) => el('p', { class: 'limitation' }, text)), form,
    el('details', {}, el('summary', {}, `Existing native sessions (${value.sessions.length})`),
      el('p', { class: 'muted' }, 'Choose this installation’s saved profile on the Session page to re-discover and attach an exact native reference. Attachment submits no work.'),
      ...value.sessions.map((session) => el('div', { class: 'stack' }, el('strong', {}, session.label), el('code', { class: 'mono' }, `${session.nativeSession.kind} / ${session.nativeSession.id}`)))));
  return row;
}
function environmentRow(ctx: UiContext, connection: IntegrationInventory['execution'][number]): HTMLElement {
  const row = el('article', { class: 'profile-row' }, el('h3', {}, connection.label));
  if (connection.status === 'unavailable') { row.append(el('p', { class: 'limitation' }, connection.error.message)); return row; }
  const value = connection.value;
  row.append(el('p', { class: 'mono' }, `Host ${value.hostId} / Workspace ${value.workspaceId} / Incarnation ${value.incarnation}`),
    el('p', {}, `${value.displayName}: ${value.resources.cpuCount} CPU, ${value.resources.memory}, ${value.resources.pidsLimit} PIDs`),
    el('p', { class: 'muted' }, `Attestation expires ${value.identityExpiresAt}. Work directories: ${value.workAreas.map((area) => area.path).join(', ')}`),
    ...value.limitations.map((text) => el('p', { class: 'limitation' }, text)),
    button('Register existing environment', 'secondary', () => {
      void (async () => {
        if (!await register(ctx, connection, 'execution')) return;
        await ctx.command({ commandId: commandId(), type: 'environment.register', payload: {
          label: value.displayName, executionInstallationId: connection.installationId,
          locator: { hostId: value.hostId, workspaceId: value.workspaceId, incarnation: value.incarnation },
          allowedProjectIds: value.allowedProjectIds, allowedWorkAreas: value.workAreas,
          allowRuntimeServiceLaunch: false, weakIdentityExplicitlyAccepted: false,
        } }, 'Existing environment registered. Verify it under Environments before delegation.');
      })();
    }));
  return row;
}
