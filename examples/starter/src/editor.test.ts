import { expect, it } from "vitest";
import { pythonMarkup } from "./editor.js";

it("highlights Python keywords, strings, numbers and comments", () => {
  const html = pythonMarkup('import pandas as pd\nvalue = "orders.csv" # sample\nresult = 42\n');
  for (const name of ["keyword", "string", "number", "comment"]) expect(html).toContain(`class="hljs-${name}"`);
});
it("escapes HTML in user code and accepts incomplete Python", () => {
  const source = 'value = "<img src=x onerror=alert(1)>"\n# <script>bad()</script>\n';
  const html = pythonMarkup(source);
  expect(html).not.toContain("<img"); expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;img");
  expect(() => pythonMarkup('value = """unfinished\n')).not.toThrow();
});
