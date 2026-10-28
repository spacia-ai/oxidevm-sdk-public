const MAX_SLUG_LENGTH = 40;

/**
 * The name a backup is offered under: `oxidevm-<label slug>-<YYYY-MM-DD-HHmm>.oxvm`, the time
 * being its capture time in `timeZone` (this browser's when unset).
 */
export function backupFileName(snapshot: { readonly label?: string; readonly capturedAtUnixMs: number }, timeZone?: string): string {
  const slug = (snapshot.label ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/u, "");
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(timeZone === undefined ? {} : { timeZone }),
  }).formatToParts(snapshot.capturedAtUnixMs);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((entry) => entry.type === type)?.value ?? "00";
  const time = `${part("year")}-${part("month")}-${part("day")}-${part("hour")}${part("minute")}`;
  return `oxidevm-${slug === "" ? "restore-point" : slug}-${time}.oxvm`;
}
