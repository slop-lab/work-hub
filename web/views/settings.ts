import { commandId } from "../api.ts";
import { badge, button, el, findFormValue, label, submitButton } from "../dom.ts";
import type { UiContext } from "../ui-context.ts";
import { connectionsPanel } from './connections.ts';

export function settingsView(ctx: UiContext): HTMLElement {
	const users = el("div", { class: "settings-list" });
	for (const user of ctx.state.users) {
		users.append(
			el(
				"div",
				{ class: "settings-row" },
				el("div", {}, el("strong", {}, user.displayName), el("span", { class: "mono" }, user.id)),
				el(
					"div",
					{ class: "cluster" },
					badge(user.role, user.role === "admin" ? "info" : "neutral"),
					badge(user.enabled === false ? "disabled" : "enabled", user.enabled === false ? "error" : "success"),
					ctx.state.me.role !== "admin" || user.id === ctx.state.me.id || user.revision === undefined ? null : button(user.enabled === false ? "Enable" : "Disable", "quiet", () => void updateUser(ctx, user)),
				),
			),
		);
	}
	const profiles = el("div", { class: "settings-list" });
	for (const profile of ctx.state.profiles) {
		profiles.append(
			el(
				"article",
				{ class: "profile-row" },
				el("div", {}, el("strong", {}, profile.label), el("span", { class: "mono" }, `${profile.id} revision ${profile.revision}`)),
				el(
					"div",
					{ class: "cluster" },
					profile.simulator ? badge("Simulator", "warning") : null,
					badge(profile.enabled ? "enabled" : "disabled", profile.enabled ? "success" : "error"),
					ctx.state.me.role === "admin" ? button(profile.enabled ? "Disable profile" : "Enable profile", "quiet", () => void updateProfile(ctx, profile)) : null,
				),
				el("p", { class: "muted" }, `Modes: ${profile.allowedEnvironmentModes.join(", ")}`),
				...profile.limitations.map((item) => el("p", { class: "limitation" }, item)),
			),
		);
	}
	const projects = el("div", { class: "settings-list" }, ...ctx.state.projects.map((project) => projectRow(ctx, project)));
	return el(
		"div",
		{ class: "page" },
		el("header", { class: "page-heading" }, el("div", {}, el("p", { class: "kicker" }, "Administration"), el("h1", {}, "Access and execution profiles"), el("p", { class: "lead" }, "Administrative changes affect future commands. Historical snapshots remain unchanged."))),
		ctx.state.me.role !== "admin" ? el("section", { class: "boundary-note" }, el("strong", {}, "Administrator access required"), el("p", {}, "You can view profiles and users but cannot modify them.")) : el("div", { class: "stack" }, userForm(ctx), projectForm(ctx)),
		ctx.state.me.role === 'admin' ? connectionsPanel(ctx) : null,
		el(
			"div",
			{ class: "settings-grid" },
			el("section", { class: "detail-section" }, el("header", { class: "section-heading" }, el("h2", {}, "Users"), badge(String(ctx.state.users.length))), users),
			el("section", { class: "detail-section" }, el("header", { class: "section-heading" }, el("h2", {}, "Execution profiles"), badge(String(ctx.state.profiles.length))), profiles),
			el("section", { class: "detail-section" }, el("header", { class: "section-heading" }, el("h2", {}, "Projects"), badge(String(ctx.state.projects.length))), projects),
		),
		el(
			"section",
			{ class: "detail-section export-section" },
			el("div", {}, el("h2", {}, "Export and diagnostics"), el("p", { class: "muted" }, "Exports exclude secrets and live access handles.")),
			el(
				"a",
				{
					class: "button button--secondary",
					href: "/api/v1/export",
					download: "work-hub-export.json",
				},
				"Download workspace export",
			),
		),
	);
}

function updateProfile(ctx: UiContext, profile: UiContext["state"]["profiles"][number]): Promise<boolean> {
	return ctx.command({ commandId: commandId(), type: profile.enabled ? "profile.disable" : "profile.update", target: { kind: "profile", id: profile.id }, expected: { profile: profile.revision }, payload: profile.enabled ? {} : { enabled: true } }, `Profile ${profile.enabled ? "disabled" : "enabled"} for future work.`);
}

function userForm(ctx: UiContext): HTMLElement {
	const name = el("input", {
		class: "input",
		name: "displayName",
		required: true,
		placeholder: "Display name",
	});
	const role = el("select", { class: "select", name: "role" }, el("option", { value: "member" }, "Member"), el("option", { value: "admin" }, "Administrator"));
	const form = el("form", { class: "detail-section user-form" }, el("div", {}, el("h2", {}, "Add user"), el("p", { class: "muted" }, "Users receive application authority only after an administrator creates them.")), label("Display name", name), label("Role", role), submitButton("Create user"));
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		void ctx
			.command(
				{
					commandId: commandId(),
					type: "user.create",
					payload: {
						displayName: findFormValue(form, "displayName"),
						role: findFormValue(form, "role") === "admin" ? "administrator" : "member",
						projectIds: ctx.state.projects.map((project) => project.id),
						profileIds: ctx.state.profiles.filter((profile) => profile.enabled).map((profile) => profile.id),
						bindingIds: [],
						enabled: true,
					},
				},
				"User created.",
			)
			.then((saved) => {
				if (saved) form.reset();
			});
	});
	return form;
}

function updateUser(ctx: UiContext, user: UiContext["state"]["users"][number]): Promise<boolean> {
	const enabled = user.enabled === false;
	return ctx.command(
		{
			commandId: commandId(),
			type: "user.update",
			target: { kind: "user", id: user.id },
			payload: {
				expectedRevision: user.revision ?? 1,
				enabled,
			},
		},
		`User ${enabled ? "enabled" : "disabled"}.`,
	);
}

function projectForm(ctx: UiContext): HTMLElement {
	const name = el("input", { class: "input", name: "projectName", required: true, placeholder: "Project name" });
	const form = el("form", { class: "detail-section user-form" }, el("div", {}, el("h2", {}, "Add project"), el("p", { class: "muted" }, "Projects group durable tasks and choose a deliberate default profile.")), label("Project name", name), submitButton("Create project"));
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		void ctx.command({ commandId: commandId(), type: "project.create", payload: { name: findFormValue(form, "projectName") } }, "Project created.").then((saved) => {
			if (saved) form.reset();
		});
	});
	return form;
}

function projectRow(ctx: UiContext, project: UiContext["state"]["projects"][number]): HTMLElement {
	const profile = ctx.state.profiles.find((item) => item.id === project.defaultProfileId);
	const actions = ctx.state.me.role !== "admin" ? null : button("Use first enabled profile", "quiet", () => {
		const selected = ctx.state.profiles.find((item) => item.enabled);
		if (selected === undefined) return;
		void ctx.command({ commandId: commandId(), type: "project.update", target: { kind: "project", id: project.id }, payload: { name: project.name, defaultProfileId: selected.id, expectedRevision: project.revision } }, "Project default profile updated.");
	});
	return el("article", { class: "profile-row" }, el("div", {}, el("strong", {}, project.name), el("span", { class: "mono" }, `${project.id} revision ${project.revision}`)), badge(profile?.label ?? "No default profile", profile === undefined ? "warning" : "info"), actions);
}
