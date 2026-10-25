import { commandId } from "./api.ts";
import { badge, button, el, findFormValue, label } from "./dom.ts";
import type { HubRequest, HubTask } from "./state-schema.ts";
import type { UiContext } from "./ui-context.ts";

export function openDialog(title: string, body: HTMLElement, actions: readonly HTMLElement[]): HTMLDialogElement {
	const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	const titleId = `modal-${crypto.randomUUID()}`;
	const dialog = el(
		"dialog",
		{ class: "modal", "aria-labelledby": titleId },
		el(
			"div",
			{ class: "modal__head" },
			el("h2", { id: titleId }, title),
			button("Close", "quiet", () => dialog.close()),
		),
		body,
		el("div", { class: "modal__actions" }, ...actions),
	);
	dialog.addEventListener("cancel", (event) => {
		if (dialog.getAttribute("aria-busy") === "true") event.preventDefault();
	});
	dialog.addEventListener("close", () => {
		dialog.remove();
		returnFocus?.focus({ preventScroll: true });
	});
	document.body.append(dialog);
	dialog.showModal();
	dialog.querySelector<HTMLElement>("input, textarea, select, button")?.focus();
	return dialog;
}

export function answerDialog(ctx: UiContext, request: HubRequest): void {
	const field = (() => {
		switch (request.answerSchema.kind) {
			case "text":
				return el("textarea", {
					class: "textarea",
					name: "answer",
					rows: "4",
					required: true,
				});
			case "single_choice": {
				const select = el("select", {
					class: "select",
					name: "answer",
					required: true,
				});
				select.append(el("option", { value: "" }, "Choose an answer"));
				for (const option of request.answerSchema.options) select.append(el("option", { value: option.id }, option.label));
				return select;
			}
			case "approval": {
				const select = el("select", {
					class: "select",
					name: "answer",
					required: true,
				});
				select.append(el("option", { value: "" }, "Choose a decision"), el("option", { value: "approve" }, "Approve"), el("option", { value: "deny" }, "Deny"));
				return select;
			}
		}
	})();
	const form = el("form", { class: "stack" }, el("p", { class: "lead" }, request.prompt));
	if (request.reason !== undefined) form.append(el("p", { class: "muted" }, request.reason));
	form.append(label("Answer", field, "Saving the answer and delivering it to a runtime are separate operations."));
	const save = button("Save answer", "primary");
	const dialog = openDialog(request.kind === "approval" ? "Review approval" : "Answer question", form, [save]);
	save.addEventListener("click", () => {
		const value = findFormValue(form, "answer");
		if (value.length === 0) return;
		const answer = request.answerSchema.kind === "text" ? { kind: "text", text: value } : request.answerSchema.kind === "single_choice" ? { kind: "single_choice", optionId: value } : { kind: "approval", decision: value };
		save.disabled = true;
		dialog.setAttribute("aria-busy", "true");
		void ctx
			.command(
				{
					commandId: commandId(),
					type: "request.respond",
					target: { kind: "request", id: request.id },
					expected: { request: request.revision, ...(request.bindingGeneration === undefined ? {} : { bindingGeneration: request.bindingGeneration }) },
					payload: { answer },
				},
				"Answer saved. Runtime delivery is tracked separately.",
			)
			.then((saved) => {
				if (saved) dialog.close();
				else {
					save.disabled = false;
					dialog.removeAttribute("aria-busy");
				}
			})
			.catch(() => {
				save.disabled = false;
				dialog.removeAttribute("aria-busy");
			});
	});
}

export function delegationDialog(ctx: UiContext, task: HubTask): void {
	const availableProfiles = ctx.state.profiles.filter((profile) => profile.enabled);
	const profileSelect = el("select", { class: "select", name: "profile" });
	const project = ctx.state.projects.find((item) => item.id === task.projectId);
	const configuredDefaultProfileId = project?.defaultProfileId;
	const configuredDefaultProfile = availableProfiles.find((profile) => profile.id === configuredDefaultProfileId);
	const profilePrompt = configuredDefaultProfileId === undefined ? "Choose an execution profile" : "Configured project default is unavailable — choose another profile";
	profileSelect.append(el("option", { value: "" }, profilePrompt));
	for (const profile of availableProfiles) profileSelect.append(el("option", { value: profile.id }, profile.label));
	if (configuredDefaultProfile !== undefined) profileSelect.value = configuredDefaultProfile.id;
	const modeSelect = el("select", { class: "select", name: "environment" }, el("option", { value: "existing" }, "Use an existing environment"), el("option", { value: "provision" }, "Request a new environment"), el("option", { value: "none" }, "No environment required"));
	const registrationSelect = el("select", {
		class: "select",
		name: "registration",
	});
	for (const environment of ctx.state.environments.filter((item) => item.retiredAt === undefined)) registrationSelect.append(el("option", { value: environment.id }, environment.label));
	const executionInstallations = ctx.state.installations.filter((item) => item.kind === "execution" && item.enabled && item.available);
	const executionSelect = el("select", { class: "select", name: "executionInstallation" });
	for (const installation of executionInstallations) executionSelect.append(el("option", { value: installation.id }, installation.label));
	const externalProfile = el("input", { class: "input", name: "externalProfile", value: "development-small" });
	const releasePolicy = el("input", { class: "input", name: "releasePolicy", value: "retain-until-explicit-release" });
	const registrationField = label("Existing registration", registrationSelect);
	const executionField = label("Execution connector", executionSelect, "Required only when requesting a new environment. No connector is selected implicitly.");
	const externalProfileField = label("External environment profile", externalProfile);
	const releasePolicyField = label("Release policy reference", releasePolicy);
	const syncEnvironmentFields = (): void => {
		registrationField.hidden = modeSelect.value !== "existing";
		executionField.hidden = modeSelect.value !== "provision";
		externalProfileField.hidden = modeSelect.value !== "provision";
		releasePolicyField.hidden = modeSelect.value !== "provision";
	};
	modeSelect.addEventListener("change", syncEnvironmentFields);
	const references = ctx.state.references.filter((item) => item.taskId === task.id);
	const responses = ctx.state.requests.filter((request) => request.taskId === task.id).flatMap((request) => ctx.state.responses.filter((response) => response.requestId === request.id).map((response) => ({ response, request })));
	const selections = el("div", { class: "stack" }, el("strong", {}, "Selected context"), references.length === 0 ? el("p", { class: "muted" }, "No task references are available.") : el("div", { class: "selection-list" }, ...references.map((item) => checkbox(`Include reference ${item.title}`, "referenceId", item.id))), responses.length === 0 ? el("p", { class: "muted" }, "No saved answers are available.") : el("div", { class: "selection-list" }, ...responses.map(({ response, request }) => checkbox(`Include answer to ${request.prompt}`, "responseId", response.id))));
	const form = el(
		"form",
		{ class: "stack" },
		el("div", { class: "preview-title" }, badge("Preview", "info"), el("strong", {}, task.title)),
		label("Execution profile", profileSelect, configuredDefaultProfileId !== undefined && configuredDefaultProfile === undefined ? "The project's configured default profile is disabled or unavailable. Select another enabled profile explicitly." : undefined),
		label("Environment choice", modeSelect),
		registrationField,
		executionField,
		externalProfileField,
		releasePolicyField,
		selections,
		el("section", { class: "boundary-note" }, el("strong", {}, "Existing environment attachment does not grant lifecycle control."), el("p", {}, "Verification and attachment preserve existing contents. Detach ends hub access only; it does not stop or delete the environment.")),
		el("details", {}, el("summary", {}, "Advanced effects"), el("p", { class: "muted" }, "The accepted command snapshots task revision, profile revision, selected environment, and allowed effects. No implicit fallback is permitted.")),
	);
	const confirm = button("Confirm delegation", "primary");
	const dialog = openDialog("Delegate task", form, [button("Cancel", "secondary", () => dialog.close()), confirm]);
	syncEnvironmentFields();
	confirm.addEventListener("click", () => {
		const profileId = findFormValue(form, "profile");
		const profile = availableProfiles.find((item) => item.id === profileId);
		const mode = findFormValue(form, "environment");
		if (profile === undefined) {
			ctx.notice("Select an enabled execution profile before delegating.", "error");
			return;
		}
		const environment =
			mode === "existing"
				? existingSelection(ctx, findFormValue(form, "registration"))
				: mode === "provision"
					? executionInstallations.length === 0
						? null
						: {
							mode: "provision",
							executionInstallationId: findFormValue(form, "executionInstallation"),
							externalProfileRef: findFormValue(form, "externalProfile"),
							parameters: {},
							releasePolicyRef: findFormValue(form, "releasePolicy"),
							workAreas: [],
						}
					: { mode: "none" };
		if (environment === null) {
			ctx.notice("No enabled execution connector is available for provisioning.", "error");
			return;
		}
		confirm.disabled = true;
		dialog.setAttribute("aria-busy", "true");
		void ctx
			.command(
				{
					commandId: commandId(),
					type: "attempt.delegate",
					target: { kind: "task", id: task.id },
					expected: { task: task.revision, profile: profile.revision },
					payload: {
						profileId,
						environment,
						selectedReferenceIds: new FormData(form).getAll("referenceId").filter((value): value is string => typeof value === "string"),
						selectedResponseIds: new FormData(form).getAll("responseId").filter((value): value is string => typeof value === "string"),
					},
				},
				"Delegation accepted. Preparation and runtime input remain separately visible.",
			)
			.then((saved) => {
				if (saved) dialog.close();
				else {
					confirm.disabled = false;
					dialog.removeAttribute("aria-busy");
				}
			})
			.catch(() => {
				confirm.disabled = false;
				dialog.removeAttribute("aria-busy");
			});
	});
}

function checkbox(text: string, name: string, value: string): HTMLElement {
	const control = el("input", { type: "checkbox", name, value, checked: true });
	control.setAttribute("aria-label", text);
	return el("label", { class: "choice-row" }, control, el("span", {}, text));
}

function existingSelection(ctx: UiContext, registrationId: string): Readonly<Record<string, unknown>> | null {
	const registration = ctx.state.environments.find((item) => item.id === registrationId);
	if (registration === undefined) return null;
	return {
		mode: "existing",
		registrationId,
		expectedRegistrationRevision: registration.revision,
		requestedAccess: "write",
		workAreas: registration.workAreas.map((area) => ({
			...area,
			pathNamespace: "provider-guest-posix",
			preparation: "preserve_existing",
		})),
	};
}
