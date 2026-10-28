import { VMError } from "@oxidevm/sdk";
export function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new VMError("PROTOCOL_ERROR", `${label} must be an object`);
  return Object.fromEntries(Object.entries(value));
}
export function fields(input: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(input, key)) || Object.keys(input).some(key => !required.includes(key) && !optional.includes(key))) throw new VMError("PROTOCOL_ERROR", "unexpected or missing report fields");
}
export function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 8192 || Array.from(value).some(char => char.charCodeAt(0) < 32 && ![9, 10, 13].includes(char.charCodeAt(0)))) throw new VMError("PROTOCOL_ERROR", "invalid report string");
  return value;
}
export function number(value: unknown, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new VMError("PROTOCOL_ERROR", "invalid report integer");
  return value;
}
export function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  for (const item of choices) if (item === value) return item;
  throw new VMError("PROTOCOL_ERROR", "invalid report choice");
}
