import { commandId } from "../api.ts";
import { badge, button, el, findFormValue, formatTime, label, submitButton } from "../dom.ts";
import type { HubBinding, HubEnvironment } from "../state-schema.ts";
import type { UiContext } from "../ui-context.ts";

export function environmentsView(ctx: UiContext): HTMLElement {
	const registrations = el("div", { class: "environment-grid" }, ...ctx.state.environments.map((environment) => registrationCard(ctx, environment)));
	const bindings = ctx.state.environmentBindings.length === 0 ? el("div", { class: "empty-state" }, el("h2", {}, "No active bindings"), el("p", {}, "A saved registration is not an attachment.")) : el("div", { class: "environment-grid" }, ...ctx.state.environmentBindings.map((binding) => bindingCard(ctx, binding)));
	return el(
		"div",
		{ class: "page" },
		el("header", { class: "page-heading" }, el("div", {}, el("p", { class: "kicker" }, "Connections"), el("h1", {}, "Environments have boundaries"), el("p", { class: "lead" }, "Register and verify without provisioning. Detach access without implying deletion."))),
		registerForm(ctx),
		el("section", { class: "stack" }, el("header", { class: "section-heading" }, el("h2", {}, "Saved registrations"), badge(String(ctx.state.environments.length))), registrations),
		el("section", { class: "stack" }, el("header", { class: "section-heading" }, el("h2", {}, "Current bindings"), badge(String(ctx.state.environmentBindings.length))), bindings),
	);
}

function registerForm(ctx: UiContext): HTMLElement {
	const installations = ctx.state.installations.filter((item) => item.kind === "execution" && item.enabled && item.available);
	const installation = el("select", { class: "select", name: "installation" });
	for (const item of installations) installation.append(el("option", { value: item.id }, item.label));
	const project = el("select", { class: "select", name: "project" });
	for (const item of ctx.state.projects) project.append(el("option", { value: item.id }, item.name));
	const labelInput = el("input", {
		class: "input",
		name: "label",
		required: true,
		placeholder: "Shared development container",
	});
	const locator = el("input", {
		class: "input",
		name: "locator",
		required: true,
		placeholder: "provider-approved locator",
	});
	const workArea = el("input", {
		class: "input",
		name: "workArea",
		required: true,
		placeholder: "/workspace/project",
	});
	const form = el(
		"form",
		{ class: "detail-section registration-form" },
		el("div", {}, el("h2", {}, "Register existing environment"), el("p", { class: "muted" }, "Registration stores an approved locator. Verification is read-only and does not initialize the guest.")),
		label("Execution connector", installation, installations.length === 0 ? "No enabled execution connector is available. Registration is disabled." : "Only enabled, installed connectors are selectable."),
		label("Allowed project", project),
		label("Name", labelInput),
		label("Provider locator", locator, "Do not paste credentials."),
		label("Allowed working directory", workArea),
		(() => { const submit = submitButton("Register"); submit.disabled = installations.length === 0; return submit; })(),
	);
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		if (installations.length === 0) return;
		const projectId = findFormValue(form, "project");
		void ctx
			.command(
				{
					commandId: commandId(),
					type: "environment.register",
					payload: {
						label: findFormValue(form, "label"),
						executionInstallationId: findFormValue(form, "installation"),
						locator: { value: findFormValue(form, "locator") },
						secretRefs: [],
						allowedProjectIds: [projectId],
						allowedWorkAreas: [
							{
								key: "primary",
								path: findFormValue(form, "workArea"),
								pathNamespace: "provider-guest-posix",
								requestedAccess: "write",
								preparation: "preserve_existing",
							},
						],
						allowRuntimeServiceLaunch: false,
					},
				},
				"Environment registered. No external change was made.",
			)
			.then((saved) => {
				if (saved) form.reset();
			});
	});
	return form;
}

function registrationCard(ctx: UiContext, environment: HubEnvironment): HTMLElement {
	const verified = environment.verifiedAt !== undefined;
	return el(
		"article",
		{ class: "environment-card" },
		el("div", { class: "environment-card__head" }, el("div", {}, el("h3", {}, environment.label), el("p", { class: "mono" }, environment.id)), badge(verified ? "Verified" : "Unverified", verified ? "success" : "warning")),
		el(
			"dl",
			{ class: "definition-list" },
			el("dt", {}, "Identity"),
			el("dd", {}, environment.identityAssurance ?? "Not observed"),
			el("dt", {}, "State"),
			el("dd", {}, environment.observedState ?? "Unknown"),
			el("dt", {}, "Verified"),
			el("dd", {}, environment.verifiedAt === undefined ? "Never" : formatTime(environment.verifiedAt)),
		),
		el("ul", { class: "plain-list" }, ...environment.workAreas.map((area) => el("li", {}, el("span", { class: "mono" }, area.path), badge(area.requestedAccess)))),
		...environment.limitations.map((item) => el("p", { class: "limitation" }, item)),
		button(
			"Verify read-only",
			"secondary",
			() =>
				void ctx.command(
					{
						commandId: commandId(),
						type: "environment.verify",
						target: { kind: "environment_registration", id: environment.id },
						expected: { registration: environment.revision },
						payload: {},
					},
					"Verification requested. No guest initialization is authorized.",
				),
		),
	);
}

function bindingCard(ctx: UiContext, binding: HubBinding): HTMLElement {
	const actions = el("div", { class: "cluster" });
	if (binding.canDetach)
		actions.append(
			button(
				"Detach access",
				"secondary",
				() =>
					void ctx.command(
						{
							commandId: commandId(),
							type: "environment.detach",
							target: { kind: "environment_binding", id: binding.id },
							expected: { bindingGeneration: binding.generation },
							payload: { reason: "Detached from environment page" },
						},
						"Attachment detached. External environment and data are preserved.",
					),
			),
		);
	if (binding.canRelease)
		actions.append(releaseControls(ctx, binding));
	return el(
		"article",
		{ class: "environment-card" },
		el("div", { class: "environment-card__head" }, el("h3", {}, binding.identityLabel), badge(binding.origin === "allocated" ? "Managed allocation" : "Existing attachment", binding.origin === "allocated" ? "info" : "warning")),
		el("p", {}, binding.origin === "allocated" ? "Release applies only through the recorded lifecycle grant and retention policy." : "Detach ends hub access only. Release is unavailable for attach-only targets."),
		el("div", { class: "cluster" }, badge(binding.state, "info"), badge(`${binding.access} access`), badge(`${binding.enforcement} enforcement`, binding.enforcement === "enforced" ? "success" : "warning")),
		...binding.limitations.map((item) => el("p", { class: "limitation" }, item)),
		actions,
	);
}

function releaseControls(ctx: UiContext, binding: HubBinding): HTMLElement {
	const preservation = el("select", { class: "select", name: `preservation-${binding.id}` }, el("option", { value: "preserve_references" }, "Preserve references"), el("option", { value: "accept_reference_expiry" }, "Accept that remote references may expire"));
	return el("div", { class: "stack release-controls" }, label("Release preservation decision", preservation), button("Apply release policy", "danger", () => void ctx.command({ commandId: commandId(), type: "environment.release", target: { kind: "environment_binding", id: binding.id }, expected: { bindingGeneration: binding.generation }, payload: { preservationDecisionRef: preservation.value } }, "Allocation release requested under its recorded policy.")));
}
