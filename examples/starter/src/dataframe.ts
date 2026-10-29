export const maxUploadBytes = 5 * 1024 ** 2;
export type Cell = string | number | boolean | null;
export interface Dataframe {
  readonly columns: readonly { readonly name: string; readonly dtype: string }[];
  readonly rows: readonly (readonly Cell[])[];
  readonly index: readonly string[];
  readonly rowCount: number;
  readonly csvAvailable: boolean;
  readonly versions: { readonly python: string; readonly pandas: string; readonly numpy: string };
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid dataframe object");
  return Object.fromEntries(Object.entries(value));
}
function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).length !== expected.length || !expected.every(key => Object.hasOwn(value, key))) throw new Error("Unexpected dataframe fields");
}
function text(value: unknown, max = 2000): string {
  if (typeof value !== "string" || value.length > max) throw new Error("Invalid dataframe text");
  return value;
}
export function decodeDataframe(value: unknown): Dataframe {
  const input = object(value);
  keys(input, ["schemaVersion", "columns", "rows", "index", "rowCount", "csvAvailable", "versions"]);
  if (input["schemaVersion"] !== 1 || !Array.isArray(input["columns"]) || input["columns"].length > 64 || !Array.isArray(input["rows"]) || input["rows"].length > 200 || !Array.isArray(input["index"])) throw new Error("Dataframe exceeds the preview limits");
  const columns = Array.from<unknown>(input["columns"]).map(value => { const item = object(value); keys(item, ["name", "dtype"]); return { name: text(item["name"], 128), dtype: text(item["dtype"], 128) }; });
  const rows = Array.from<unknown>(input["rows"]).map(value => {
    if (!Array.isArray(value) || value.length !== columns.length) throw new Error("Dataframe row width differs from its columns");
    return Array.from<unknown>(value).map((cell): Cell => {
      if (cell === null || typeof cell === "boolean" || typeof cell === "number" && Number.isFinite(cell)) return cell;
      return text(cell);
    });
  });
  const index = Array.from<unknown>(input["index"]).map(value => text(value));
  const count = input["rowCount"];
  if (index.length !== rows.length || typeof count !== "number" || !Number.isSafeInteger(count) || count < rows.length || typeof input["csvAvailable"] !== "boolean") throw new Error("Invalid dataframe row count");
  const versions = object(input["versions"]); keys(versions, ["python", "pandas", "numpy"]);
  return { columns, rows, index, rowCount: count, csvAvailable: input["csvAvailable"], versions: { python: text(versions["python"], 64), pandas: text(versions["pandas"], 64), numpy: text(versions["numpy"], 64) } };
}
export function uploadError(file: { readonly name: string; readonly size: number }): string | undefined {
  if (!/\.csv$/iu.test(file.name)) return "Choose a CSV file (.csv).";
  if (file.size === 0) return "This CSV file is empty.";
  if (file.size > maxUploadBytes) return "Choose a CSV no larger than 5 MiB.";
  return undefined;
}
