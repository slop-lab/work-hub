export function assertNever(value: never): never {
  throw new TypeError(`Unhandled variant: ${String(value)}`);
}
