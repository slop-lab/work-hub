import { type HandoffPreview, type HandoffRecipient, ApiError, commandId, previewHandoff, registerProjectRepository, sendCommand } from "../api.ts";
import { badge, button, el, findFormValue, label } from "../dom.ts";
import { openDialog } from "../dialogs.ts";
import type { HubTask } from "../state-schema.ts";
import type { UiContext } from "../ui-context.ts";

export function prepareHandoffDialog(ctx: UiContext, task: HubTask): void {
	const profiles = ctx.state.profiles.filter((profile) => profile.enabled && ctx.state.installations.some((installation) => installation.id === profile.runtimeInstallationId && installation.enabled && installation.available));
	const profile = el("select", { class: "select", name: "profileId", required: true }, el("option", { value: "" }, "Choose an execution profile"));
	for (const item of profiles) profile.append(el("option", { value: item.id }, item.label));
	const projectDefault = ctx.state.projects.find((project) => project.id === task.projectId)?.defaultProfileId;
	if (projectDefault !== undefined && profiles.some((item) => item.id === projectDefault)) profile.value = projectDefault;

	const recipient = el("select", { class: "select", name: "recipient", required: true }, el("option", { value: "new" }, "Create a new recipient session"));
	for (const session of ctx.state.sessions.filter((item) => item.taskId === task.id && item.profileId !== undefined)) {
		const active = ctx.state.attempts.find((attempt) => attempt.id === session.activeAttemptId);
		const option = el("option", { value: session.id }, `${session.runtimeLabel} · ${session.id} · ${active?.phase ?? session.state}`);
		option.disabled = session.state !== "open" || session.controlMode !== "control" || (active !== undefined && active.phase !== "finished");
		recipient.append(option);
	}

	const repository = el("input", { class: "input", name: "repositoryIdentity", required: true, placeholder: "https://host/owner/repository.git" });
	const branch = el("input", { class: "input", name: "sourceBranch", required: true, placeholder: "main" });
	const commit = el("input", { class: "input", name: "sourceCommit", required: true, minlength: "40", maxlength: "64", pattern: "[0-9a-f]{40}|[0-9a-f]{64}" });
	const validation = el("textarea", { class: "textarea", name: "requestedValidation", required: true, rows: "4" });
	const contextDigest = el("input", { class: "input", name: "contextDigest", required: true, pattern: "[a-z0-9][a-z0-9_-]*:.+" });
	const previewRegion = el("section", { class: "handoff-preview", "aria-label": "Exact canonical prompt", hidden: true });
	const message = el("p", { class: "form-message", role: "alert" });
	const references = ctx.state.references.filter((item) => item.taskId === task.id);
	const referenceChoices = references.length === 0
		? el("p", { class: "muted" }, "No retained task references are available.")
		: el("div", { class: "selection-list" }, ...references.map((item) => {
			const control = el("input", { type: "checkbox", name: "referenceId", value: item.id, checked: true });
			return el("label", { class: "choice-row" }, control, el("span", {}, `${item.title} · ${item.availability}`));
		}));
	const form = el(
		"form",
		{ class: "stack", "data-form-key": `handoff:${task.id}` },
		el("p", {}, "Register a credential-free repository identity, bind an exact source, and inspect the canonical prompt before first send."),
		label("Repository identity", repository, "Registration stores identity only. It does not collect repository credentials."),
		el("div", { class: "form-grid handoff-source-fields" }, label("Source branch", branch), label("Full source commit", commit), label("Requested validation", validation), label("Context digest", contextDigest)),
		label("Execution profile", profile),
		label("Recipient session", recipient, "Choose a permitted idle control session or explicitly create a new session."),
		el("section", { class: "boundary-note" }, el("strong", {}, "Context references"), referenceChoices),
		previewRegion,
		message,
	);
	const previewButton = button("Preview exact handoff", "secondary", () => void createPreview());
	const sendButton = button("Send verification handoff", "primary", () => void send());
	sendButton.disabled = true;
	const dialog = openDialog("Prepare verification handoff", form, [button("Cancel", "quiet", () => dialog.close()), previewButton, sendButton]);
	let preview: HandoffPreview | undefined;

	form.addEventListener("input", () => {
		if (preview === undefined) return;
		preview = undefined;
		previewRegion.hidden = true;
		previewRegion.replaceChildren();
		sendButton.disabled = true;
		message.textContent = "Source or recipient changed. Create a fresh preview before sending.";
	});

	async function createPreview(): Promise<void> {
		if (!form.reportValidity()) return;
		const selectedProfile = profiles.find((item) => item.id === profile.value);
		const selectedRecipient = handoffRecipient(ctx, recipient.value);
		if (selectedProfile === undefined || selectedRecipient === undefined) {
			message.textContent = "Choose an enabled profile and a permitted recipient session.";
			return;
		}
		setBusy(true);
		try {
			const registered = await registerProjectRepository({ projectId: task.projectId, canonicalIdentity: repository.value });
			preview = await previewHandoff({ taskId: task.id, profileId: selectedProfile.id, repositoryId: registered.id, repositoryRevision: registered.revision, sourceBranch: branch.value, sourceCommit: commit.value, requestedValidation: validation.value, contextDigest: contextDigest.value, recipient: selectedRecipient });
			previewRegion.replaceChildren(
				el("div", { class: "section-heading" }, el("h2", {}, "Exact canonical prompt"), badge("Ready", "success")),
				facts([["Repository", preview.repository.canonicalIdentity], ["Branch", preview.verification.sourceBranch], ["Full commit", preview.verification.sourceCommit], ["Target", preview.recipient.kind === "new" ? "New session" : preview.recipient.sessionId], ["Prompt digest", preview.promptDigest], ["Preview digest", preview.previewDigest]]),
				el("pre", { class: "handoff-context", "data-prompt-digest": preview.promptDigest }, preview.prompt),
			);
			previewRegion.hidden = false;
			message.textContent = "";
			sendButton.disabled = false;
		} catch (error) {
			message.textContent = error instanceof Error ? error.message : "Preview could not be created.";
		} finally {
			setBusy(false);
		}
	}

	async function send(): Promise<void> {
		if (preview === undefined) return;
		setBusy(true);
		try {
			const selectedReferenceIds = new FormData(form).getAll("referenceId")
				.filter((value): value is string => typeof value === "string");
			const receipt = await sendCommand({ commandId: commandId(), type: "attempt.delegate",
				target: { kind: "task", id: task.id },
				expected: { task: preview.taskRevision, profile: preview.profileRevision },
				payload: { profileId: preview.profileId, environment: { mode: "none" }, selectedReferenceIds,
					selectedResponseIds: [], authorizedEffectKinds: [], handoff: { previewDigest: preview.previewDigest,
						verification: preview.verification, recipient: preview.recipient } } });
			const attemptId = receipt.objectRefs.find((item) => item.kind === "attempt")?.id;
			if (attemptId === undefined) throw new TypeError("Delegation receipt did not identify an attempt");
			dialog.close();
			ctx.notice("Verification handoff accepted. Delivery and acknowledgement remain separately visible.", "success");
			ctx.navigate(`#/backlog/${task.id}/handoff/${attemptId}`);
		} catch (error) {
			message.textContent = error instanceof ApiError ? error.message : error instanceof Error ? error.message : "Handoff could not be sent.";
		} finally {
			setBusy(false);
		}
	}

	function setBusy(busy: boolean): void {
		dialog.setAttribute("aria-busy", String(busy));
		previewButton.disabled = busy;
		sendButton.disabled = busy || preview === undefined;
	}
}

function handoffRecipient(ctx: UiContext, value: string): HandoffRecipient | undefined {
	if (value === "new") return { kind: "new" };
	const session = ctx.state.sessions.find((item) => item.id === value);
	const profile = session?.profileId === undefined ? undefined : ctx.state.profiles.find((item) => item.id === session.profileId);
	if (session === undefined || profile === undefined) return undefined;
	return { kind: "attached", sessionId: session.id, sessionRevision: session.revision, bindingGeneration: session.bindingGeneration, profileId: profile.id, profileRevision: profile.revision };
}

function facts(items: readonly (readonly [string, string])[]): HTMLElement {
	return el("dl", { class: "definition-list" }, ...items.flatMap(([term, value]) => [el("dt", {}, term), el("dd", { class: "mono" }, value)]));
}
