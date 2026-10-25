type EditableControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

type FocusState = {
	readonly control: EditableControl;
	readonly selectionStart?: number | null;
	readonly selectionEnd?: number | null;
};

export type DirtyFormIsland = {
	readonly identity: string;
	readonly key: string;
	readonly form: HTMLFormElement;
	readonly focus?: FocusState;
};

function isEditableControl(value: Element): value is EditableControl {
	return value instanceof HTMLInputElement || value instanceof HTMLTextAreaElement || value instanceof HTMLSelectElement;
}

function formKey(form: HTMLFormElement): string | null {
	const declared = form.dataset["formKey"];
	if (declared !== undefined) return declared;
	const names = [...form.elements]
		.filter((element): element is EditableControl => isEditableControl(element))
		.map((element) => element.name)
		.filter((name) => name.length > 0)
		.sort();
	return names.length === 0 ? null : [...new Set(names)].join("|");
}

export function markDirtyForm(event: Event): void {
	if (!(event.target instanceof Element)) return;
	const form = event.target.closest("form");
	if (form instanceof HTMLFormElement) form.dataset["dirty"] = "true";
}

export function markFormClean(form: HTMLFormElement | null): void {
	if (form !== null) delete form.dataset["dirty"];
}

export function captureDirtyForms(root: HTMLElement, identity: string): readonly DirtyFormIsland[] {
	const active = document.activeElement;
	return [...root.querySelectorAll<HTMLFormElement>('form[data-dirty="true"]')].flatMap((form) => {
		const key = formKey(form);
		if (key === null) return [];
		const focus = active instanceof Element && form.contains(active) && isEditableControl(active)
			? {
					control: active,
					...(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? { selectionStart: active.selectionStart, selectionEnd: active.selectionEnd } : {}),
				}
			: undefined;
		return [{ identity, key, form, ...(focus === undefined ? {} : { focus }) }];
	});
}

export function restoreDirtyForms(root: HTMLElement, identity: string, islands: readonly DirtyFormIsland[]): void {
	for (const island of islands) {
		if (island.identity !== identity) continue;
		const replacement = [...root.querySelectorAll<HTMLFormElement>("form")].find((form) => formKey(form) === island.key);
		if (replacement === undefined) continue;
		replacement.replaceWith(island.form);
		if (island.focus === undefined) continue;
		island.focus.control.focus({ preventScroll: true });
		if ((island.focus.control instanceof HTMLInputElement || island.focus.control instanceof HTMLTextAreaElement) && island.focus.selectionStart !== undefined && island.focus.selectionEnd !== undefined) {
			island.focus.control.setSelectionRange(island.focus.selectionStart, island.focus.selectionEnd);
		}
	}
}
