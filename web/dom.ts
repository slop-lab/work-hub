export type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Readonly<Record<string, string | boolean | EventListener>> = {}, ...children: readonly Child[]): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	for (const [name, value] of Object.entries(attrs)) {
		if (typeof value === "boolean") {
			if (value) node.setAttribute(name, "");
		} else if (typeof value === "function") {
			node.addEventListener(name, value);
		} else if (name === "class") {
			node.className = value;
		} else {
			node.setAttribute(name, value);
		}
	}
	for (const child of children) {
		if (child instanceof Node) node.append(child);
		else if (typeof child === "string") node.append(document.createTextNode(child));
	}
	return node;
}

export function clear(node: HTMLElement): void {
	node.replaceChildren();
}

export function label(text: string, control: HTMLElement, helper?: string): HTMLElement {
	const wrapper = el("label", { class: "field" }, el("span", { class: "field__label" }, text), control);
	if (helper !== undefined) wrapper.append(el("span", { class: "field__helper" }, helper));
	return wrapper;
}

export function button(text: string, variant = "secondary", onClick?: EventListener): HTMLButtonElement {
	const attrs: Record<string, string | EventListener> = {
		class: `button button--${variant}`,
		type: onClick === undefined ? "submit" : "button",
	};
	if (onClick !== undefined) attrs["click"] = onClick;
	return el("button", attrs, text);
}

export function submitButton(text: string, variant = "primary"): HTMLButtonElement {
	const value = button(text, variant);
	value.type = "submit";
	return value;
}

export function badge(text: string, tone = "neutral"): HTMLElement {
	return el("span", { class: `badge badge--${tone}` }, text);
}

export function formatTime(value: string): string {
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(value));
}

export function findFormValue(form: HTMLFormElement, name: string): string {
	const value = new FormData(form).get(name);
	return typeof value === "string" ? value.trim() : "";
}
