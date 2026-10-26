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
  const row = el('article', { class: 'profile-row' }, el('h3', {}, connection.label));
  if (connection.status === 'unavailable') { row.append(el('p', { class: 'limitation' }, `${connection.error.code}: ${connection.error.message}`)); return row; }
  const value = connection.value;
  const agent = el('select', { class: 'select', name: 'runtime-agent', required: true }, ...value.agents.map((name) => el('option', { value: name }, name)));
  const model = el('select', { class: 'select', name: 'runtime-model', required: true }, ...value.models.map((item, index) => el('option', { value: String(index) }, `${item.providerID}/${item.modelID}`)));
  const project = el('select', { class: 'select', name: 'runtime-project' }, ...ctx.state.projects.map((item) => el('option', { value: item.id }, item.name)));
  const environment = el('select', { class: 'select', name: 'runtime-environment' }, ...ctx.state.environments.filter((item) =>
    item.executionInstallationId === value.environment?.executionInstallationId && item.retiredAt === undefined)
    .map((item) => el('option', { value: item.id }, item.label)));
  const submit = submitButton('Save execution profile');
  submit.disabled = !value.agents.length || !value.models.length || (value.environment !== null && environment.options.length === 0);
  const form = el('form', { class: 'stack' }, label('OpenCode agent', agent), label('Connected model', model), label('Work Hub project', project),
    value.environment === null ? null : label('Mapped DIM registration', environment, 'Register the mapped environment first. Environment-free work cannot bypass its use grant.'),
    el('p', { class: 'muted' }, 'Saving a profile sends no prompt. Delegate from a task to deliberately create a session, or attach a discovered session below.'), submit);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const selected = value.models[Number(model.value)];
    if (!selected) return;
    const registration = ctx.state.environments.find((item) => item.id === environment.value);
    const defaultEnvironment = value.environment === null ? { mode: 'none' } : registration ? {
      mode: 'existing', registrationId: registration.id, expectedRegistrationRevision: registration.revision,
      requestedAccess: registration.workAreas.some((area) => area.requestedAccess === 'write') ? 'write' : 'read',
      workAreas: registration.workAreas.map((area) => ({ ...area, preparation: 'preserve_existing' })),
    } : undefined;
    if (!defaultEnvironment) return;
    void (async () => {
      if (!await register(ctx, connection, 'agent_runtime')) return;
      await ctx.command({ commandId: commandId(), type: 'profile.create', payload: {
        label: `${connection.label}: ${agent.value}`, runtimeInstallationId: connection.installationId,
        configuration: { agent: agent.value, model: selected, projectId: project.value },
        allowedEnvironmentModes: value.environment === null ? ['none'] : ['existing'], defaultEnvironment,
        requiredCapabilities: ['createSession', 'structuredInput'], allowedEffects: ['task.read', 'work.write'],
      } }, 'Execution profile saved. Select it during task delegation.');
    })();
  });
  row.append(el('p', { class: 'mono' }, `${connection.installationId} / OpenCode ${value.version} / ${value.directory}`), form,
    el('details', {}, el('summary', {}, `Existing native sessions (${value.sessions.length})`),
      el('p', { class: 'muted' }, 'Copy the exact native reference into Attach existing session on the intended task. Attaching does not submit work.'),
      ...value.sessions.map((session) => el('div', { class: 'stack' }, el('strong', {}, session.label), el('code', { class: 'mono' }, JSON.stringify(session.nativeSession))))));
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
