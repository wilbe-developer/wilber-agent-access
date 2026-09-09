# Wilber Agent Access

This is the official Wilber Agent Access marketplace. It installs the Wilber skill, CLI, and secure live connection in a supported personal agent client. The repository contains no Wilber credentials, workflow data, or access authority.

## Install with Claude Code

```bash
claude plugin marketplace add wilbe-developer/wilber-agent-access
claude plugin install wilber-agent-access@wilbe
```

Or ask Claude in a local Claude Code Desktop task:

> Install Wilber Agent Access from Wilbe's official marketplace at https://github.com/wilbe-developer/wilber-agent-access. Add the marketplace, install `wilber-agent-access@wilbe`, and verify the publisher and version. Keep setup explanations short and non-technical. If a fresh task is required, stop and tell me only: "Wilber Agent Access is installed. Please open a new task and send: Continue Wilber setup." In the fresh task, open secure Wilbe sign-in, verify the connection with `wilber doctor`, and recommend one useful first task. In Claude, also help me enable auto-update in Plugins > Marketplaces > Wilbe. Never ask me to paste credentials or tokens into chat.

## Codex CLI

```bash
codex plugin marketplace add wilbe-developer/wilber-agent-access
codex plugin add wilber-agent-access@wilbe
```

After installation, open a fresh task when Codex requires one. In that task, resolve the plugin's source path and run its bundled `bin/wilber auth login`. Codex opens Wilbe in the browser. Sign in with your own Wilbe account and approve the connection, then run `bin/wilber doctor`.

## Verify Wilber

Start a new task and ask:

```text
Show my Wilber identity, projects, permissions and available workflows.
```

The plugin uses one browser OAuth grant for both its MCP tools and CLI. The grant is stored in the operating system credential store and is never copied into chat.

The bundled `wilber` CLI remains available for complete workflow exports and local workflow editing. It uses the same authorization as the plugin connection:

```bash
wilber auth login
wilber doctor
```

That login opens Wilbe in the browser and stores the resulting OAuth grant in the operating system credential store. The local MCP proxy reads the same grant. It does not ask for a token. `wilber auth login --manual` remains available only as an explicit compatibility fallback for clients that cannot complete browser authorization.

## Versioning and provenance

Wilbe publishes versioned Git history and release tags in this repository. The authenticated ZIP available in Wilbe Profile Settings is a fallback build of the same source and includes `RELEASE.json` with the originating platform commit.
