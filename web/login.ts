import { button, el, findFormValue, label } from "./dom.ts";

export function loginScreen(onLogin: (token: string) => Promise<void>): HTMLElement {
	const input = el("input", {
		name: "token",
		type: "password",
		autocomplete: "current-password",
		required: true,
		class: "input",
		id: "login-token",
	});
	const message = el("p", { class: "form-message", "aria-live": "polite" });
	const submit = button("Sign in", "primary");
	submit.type = "submit";
	const form = el(
		"form",
		{ class: "login-card" },
		el("div", { class: "login-card__brand" }, el("span", { class: "brand__mark", "aria-hidden": "true" }), "Work Hub"),
		el("h1", {}, "Return to the work"),
		el("p", {}, "Use the local bootstrap token. It is exchanged for an HttpOnly browser session and is never stored in this page."),
		label("Bootstrap token", input),
		message,
		submit,
	);
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		const token = findFormValue(form, "token");
		if (token.length === 0) return;
		submit.disabled = true;
		submit.textContent = "Signing in";
		void onLogin(token).catch((error: unknown) => {
			message.textContent = error instanceof Error ? error.message : "Sign in failed.";
			submit.disabled = false;
			submit.textContent = "Sign in";
			input.focus();
		});
	});
	return el("main", { class: "login-screen" }, form);
}
