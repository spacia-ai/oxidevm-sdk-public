# Build with Codex or Claude

The generated starter includes OxideVM project skills for Codex and Claude Code.
Open its folder in your code app. No plugin installation is required.

Try this prompt:

> Add a revenue chart from the DataFrame result. Keep Python running in Linux.

The skills cover SDK integration, the Python/pandas starter, and debugging.
They use the installed SDK's version and declarations. `AGENT_SKILLS.json`
records the public source revision, file hashes and matching SDK version.
Project copies stay with the application until you explicitly update them.

## Install the plugin for other projects

Use current Codex or Claude Code. Install in the environment where your code
agent runs, including the remote host for an SSH session.

### Codex

```sh
codex plugin marketplace add spacia-ai/oxidevm-skills
codex plugin add oxidevm@oxidevm
```

To refresh an existing installation:

```sh
codex plugin marketplace upgrade oxidevm
codex plugin add oxidevm@oxidevm
```

### Claude Code

Claude Code 2.1.292 or newer supports one combined command:

```sh
claude plugin install oxidevm --marketplace spacia-ai/oxidevm-skills
```

On older versions, use these commands inside Claude Code:

```text
/plugin marketplace add spacia-ai/oxidevm-skills
/plugin install oxidevm@oxidevm
```

Third-party marketplace auto-updates are off by default. In `/plugin`, open
**Marketplaces**, select **OxideVM**, then enable auto-update. Follow the
client's reload message or start a new session. For a manual update:

```sh
claude plugin update oxidevm@oxidevm
```

## Desktop apps

**Codex desktop:** open or add the generated folder and select it for your
task. Project skills need no extra installation. For other projects, add the
marketplace with the commands above and inspect it in the plugin browser.
Restart the client if its skill list was already loaded.

**Claude Code in Claude Desktop:** use a local or SSH Code session that can
read the generated folder. Its `.claude/skills` files load without a separate
plugin installation. Other projects can use the plugin browser or commands
above.

**Claude Chat or Cowork:** download the plugin ZIP from the
[skills release page](https://github.com/spacia-ai/oxidevm-skills/releases/latest)
and use the custom-plugin upload option under **Customize → Plugins**. Give
the session project-folder access when needed. Uploaded ZIPs are versioned
copies; replace them to update. Opening the browser demo does not give an
agent access to local source files.

## Versions and trust

The [skills repository](https://github.com/spacia-ai/oxidevm-skills) owns the
instructions. SDK releases bundle a checked snapshot from an immutable public
commit. The synchronization workflow verifies the actual published SDK/CLI
archive before preparing its matching plugin version for review.

Use project copies for your application's SDK version. A newer global plugin
checks that version before recommending APIs. Installing it does not upgrade
the SDK, overwrite project files or authorize deployment or publication.

Skills use Apache-2.0. Engine and guest program licenses stay separate. The
plugin contains no hooks, MCP server, background service or credentials.
