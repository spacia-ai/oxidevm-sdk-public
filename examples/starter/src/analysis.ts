export const sampleCsv = `order_id,country,total
1,Netherlands,149
2,Germany,119
3,France,99
4,Netherlands,150
5,United Kingdom,129
6,Germany,120
7,France,90
8,Netherlands,150
`;
export const sampleCode = `import pandas as pd

orders = pd.read_csv("data.csv")

result = (
    orders.groupby("country", as_index=False)
    .agg(orders=("order_id", "count"),
         revenue=("total", "sum"))
    .sort_values("revenue", ascending=False)
    .reset_index(drop=True)
)
`;
export const uploadedCode = `import pandas as pd

df = pd.read_csv("data.csv")

# Edit this code to explore your CSV.
result = df.head(20)
`;

// One real Linux Python process retains imported modules between script runs.
export const pythonRunner = `import contextlib, io, json, os, platform, runpy, sys, traceback
import numpy as np
import pandas as pd

transport_in, transport_out = sys.stdin, sys.stdout
base_env, base_path = os.environ.copy(), sys.path.copy()
class BoundedOutput(io.StringIO):
    def __init__(self): super().__init__(); self.size = 0
    def write(self, text):
        self.size += len(text.encode("utf-8"))
        if self.size > 65536: raise ValueError("Python output exceeds 64 KiB")
        return super().write(text)
def bounded(text): return text.encode("utf-8")[:65536].decode("utf-8", "ignore")

def analyze(json_path, csv_path):
    scope = runpy.run_path("/workspace/analysis.py", run_name="__main__")
    result = scope.get("result")
    if not isinstance(result, pd.DataFrame):
        raise TypeError("Assign a pandas DataFrame to result, for example result = df.head(20)")
    if len(result.columns) > 64:
        raise ValueError("Preview supports up to 64 columns. Select fewer columns in result.")
    preview = result.head(200)
    split = json.loads(preview.to_json(orient="split", date_format="iso", default_handler=str))
    class LimitedCSV:
        def __init__(self, file): self.file, self.size = file, 0
        def write(self, text):
            self.size += len(text.encode("utf-8"))
            if self.size > 10 * 1024 * 1024: raise ValueError("CSV exceeds 10 MiB")
            return self.file.write(text)
    csv_available = True
    try:
        with open(csv_path, "w", encoding="utf-8", newline="") as file:
            result.to_csv(LimitedCSV(file), index=False, chunksize=1000)
    except ValueError:
        csv_available = False
        os.unlink(csv_path)
    payload = {
        "schemaVersion": 1,
        "columns": [{"name": str(name), "dtype": str(dtype)} for name, dtype in zip(result.columns, result.dtypes)],
        "rows": split["data"], "index": [str(value) for value in preview.index],
        "rowCount": len(result), "csvAvailable": csv_available,
        "versions": {"python": platform.python_version(), "pandas": pd.__version__, "numpy": np.__version__},
    }
    encoded = json.dumps(payload, allow_nan=False)
    if len(encoded.encode("utf-8")) > 2 * 1024 * 1024:
        raise ValueError("Preview exceeds 2 MiB. Select fewer rows or columns in result.")
    with open(json_path, "w", encoding="utf-8") as file: file.write(encoded)

while True:
    line = transport_in.readline(4097)
    if not line: break
    if len(line) > 4096 or not line.endswith("\\n"): raise ValueError("Invalid Python request")
    request = json.loads(line)
    if set(request) != {"id"} or not isinstance(request["id"], str): raise ValueError("Invalid Python request")
    identity = request["id"]
    if len(identity) != 36 or any(c not in "0123456789abcdef-" for c in identity): raise ValueError("Invalid run identity")
    json_path, csv_path = ("/workspace/_oxidevm/" + identity + suffix for suffix in (".json", ".csv"))
    out, err, ok, failure = BoundedOutput(), BoundedOutput(), True, ""
    try:
        os.chdir("/workspace")
        sys.argv = ["/workspace/_oxidevm/run.py", json_path, csv_path]
        sys.stdin = io.StringIO("")
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            analyze(json_path, csv_path)
    except BaseException:
        ok, failure = False, traceback.format_exc()
    finally:
        os.chdir("/workspace")
        os.environ.clear(); os.environ.update(base_env)
        sys.path[:] = base_path
        sys.stdin, sys.stdout = transport_in, transport_out
        sys.stderr = sys.__stderr__
    transport_out.write(json.dumps({"id": identity, "ok": ok, "stdout": bounded(out.getvalue()), "stderr": bounded(err.getvalue() + failure)}) + "\\n")
    transport_out.flush()
`;
