type EditableControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

type ControlState = {
	readonly key: string;
	readonly value: string;
	readonly checked?: boolean;
};

type FocusState = {
	readonly key: string;
	readonly selectionStart?: number | null;
	readonly selectionEnd?: number | null;
};

export type DirtyFormIsland = {
	readonly identity: string;
	readonly key: string;
	readonly dirty: boolean;
	readonly controls: readonly ControlState[];
	readonly focus?: FocusState;
};

const drafts = new Map<string, DirtyFormIsland>();

function isEditableControl(value: Element): value is EditableControl {
	return value instanceof HTMLInputElement || value instanceof HTMLTextAreaElement || value instanceof HTMLSelectElement;
}

function formControls(form: HTMLFormElement): readonly { readonly control: EditableControl; readonly key: string }[] {
	const counts = new Map<string, number>();
	return [...form.elements].filter((element): element is EditableControl => isEditableControl(element) && element.name.length > 0).map((control) => {
		const occurrence = counts.get(control.name) ?? 0;
		counts.set(control.name, occurrence + 1);
		return { control, key: `${control.name}:${occurrence}` };
	});
}

function formKey(form: HTMLFormElement): string | null {
	const declared = form.dataset["formKey"];
	if (declared !== undefined) return declared;
	const names = formControls(form).map((item) => item.control.name).sort();
	return names.length === 0 ? null : [...new Set(names)].join("|");
}

function draftKey(identity: string, key: string): string {
	return `${identity}\u0000${key}`;
}

function snapshot(form: HTMLFormElement, identity: string): DirtyFormIsland | undefined {
	const key = formKey(form);
	if (key === null) return undefined;
	const controls = formControls(form);
	const active = document.activeElement;
	const focused = active instanceof Element && form.contains(active) && isEditableControl(active) ? controls.find((item) => item.control === active) : undefined;
	const focus = focused === undefined ? undefined : { key: focused.key, ...(focused.control instanceof HTMLInputElement || focused.control instanceof HTMLTextAreaElement ? { selectionStart: focused.control.selectionStart, selectionEnd: focused.control.selectionEnd } : {}) };
	return { identity, key, dirty: form.dataset["dirty"] === "true", controls: controls.map(({ control, key: controlKey }) => ({ key: controlKey, value: control.value, ...(control instanceof HTMLInputElement && (control.type === "checkbox" || control.type === "radio") ? { checked: control.checked } : {}) })), ...(focus === undefined ? {} : { focus }) };
}

function remember(form: HTMLFormElement, identity: string): void {
	const island = snapshot(form, identity);
	if (island !== undefined) drafts.set(draftKey(identity, island.key), island);
}

export function markDirtyForm(event: Event, identity: string): void {
	if (!(event.target instanceof Element)) return;
	const form = event.target.closest("form");
	if (!(form instanceof HTMLFormElement)) return;
	form.dataset["dirty"] = "true";
	remember(form, identity);
}

export function markFormClean(form: HTMLFormElement | null, identity?: string): void {
	if (form === null) return;
	delete form.dataset["dirty"];
	const key = formKey(form);
	if (key === null) return;
	if (identity !== undefined) drafts.delete(draftKey(identity, key));
	else for (const [storedKey, island] of drafts) if (island.key === key) drafts.delete(storedKey);
}

export function clearDirtyForms(): void {
	drafts.clear();
}

export function captureDirtyForms(root: HTMLElement, identity: string): readonly DirtyFormIsland[] {
	for (const form of root.querySelectorAll<HTMLFormElement>('form[data-dirty="true"]')) remember(form, identity);
	const retained = [...drafts.values()].filter((island) => island.identity === identity);
	const active = document.activeElement;
	const focusedForm = active instanceof Element ? active.closest("form") : null;
	if (!(focusedForm instanceof HTMLFormElement) || !root.contains(focusedForm) || focusedForm.dataset["dirty"] === "true") return retained;
	const focused = snapshot(focusedForm, identity);
	return focused === undefined || retained.some((island) => island.key === focused.key) ? retained : [...retained, focused];
}

export function restoreDirtyForms(root: HTMLElement, identity: string, islands: readonly DirtyFormIsland[]): void {
	for (const island of islands) {
		if (island.identity !== identity) continue;
		const replacement = [...root.querySelectorAll<HTMLFormElement>("form")].find((form) => formKey(form) === island.key);
		if (replacement === undefined) continue;
		const controls = formControls(replacement);
		const restored: EditableControl[] = [];
		for (const saved of island.controls) {
			const current = controls.find((item) => item.key === saved.key)?.control;
			if (current === undefined) continue;
			current.value = saved.value;
			if (current instanceof HTMLSelectElement && current.value !== saved.value) current.dataset["restoredValue"] = saved.value;
			if (current instanceof HTMLInputElement && saved.checked !== undefined) current.checked = saved.checked;
			restored.push(current);
		}
		for (const control of restored) control.dispatchEvent(new Event("change"));
		if (island.dirty) replacement.dataset["dirty"] = "true";
		if (island.focus === undefined) continue;
		const focused = controls.find((item) => item.key === island.focus?.key)?.control;
		if (focused === undefined) continue;
		focused.focus({ preventScroll: true });
		if ((focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) && island.focus.selectionStart !== undefined && island.focus.selectionEnd !== undefined) focused.setSelectionRange(island.focus.selectionStart, island.focus.selectionEnd);
	}
}
