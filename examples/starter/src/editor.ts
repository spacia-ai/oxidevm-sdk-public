import hljs from "highlight.js/lib/core";
import python from "highlight.js/lib/languages/python";

const highlighter = hljs.newInstance();
highlighter.registerLanguage("python", python);

export function pythonMarkup(source: string): string {
  return highlighter.highlight(source, { language: "python", ignoreIllegals: true }).value;
}

/** Keep native editing, selection, undo and accessibility; color only the inert layer. */
export function pythonEditor(input: HTMLTextAreaElement, layer: HTMLPreElement, signal: AbortSignal): (value: string) => void {
  const scroll = () => { layer.scrollTop = input.scrollTop; layer.scrollLeft = input.scrollLeft; };
  const render = () => {
    if (input.value.length > 65536) layer.textContent = input.value + "\n";
    else layer.innerHTML = pythonMarkup(input.value) + "\n";
    scroll();
  };
  input.addEventListener("input", render, { signal });
  input.addEventListener("scroll", scroll, { signal });
  return value => { input.value = value; render(); };
}
