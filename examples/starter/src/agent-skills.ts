/** Copying setup guidance is independent of Linux startup and its controls. */
export function mountAgentSkills(): void {
  const button = document.getElementById("copy-agent-prompt"), prompt = document.getElementById("agent-prompt"), status = document.getElementById("agent-copy-status");
  if (!(button instanceof HTMLButtonElement) || prompt === null || status === null) throw new Error("Missing agent skills controls");
  const copy = async (): Promise<void> => {
    button.disabled = true;
    try {
      await navigator.clipboard.writeText(prompt.textContent.trim());
      status.textContent = "Prompt copied. Paste it into Codex or Claude Code.";
    } catch {
      status.textContent = "Could not copy. Select the prompt text and copy it.";
    } finally { button.disabled = false; }
  };
  button.addEventListener("click", () => { void copy(); });
}
