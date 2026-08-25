# Wilber Agent Access

This is the official Wilber Agent Access marketplace. It installs the Wilber skill, CLI, and secure live connection in a supported personal agent client. The repository contains no Wilber credentials, workflow data, or access authority.

## Install with Claude Code

```bash
claude plugin marketplace add wilbe-developer/wilber-agent-access
claude plugin install wilber-agent-access@wilbe
```

Or ask Claude:

> Install Wilber Agent Access from Wilbe's official marketplace at https://github.com/wilbe-developer/wilber-agent-access. Add the marketplace, install `wilber-agent-access@wilbe`, verify the publisher and version, and open secure browser authorization when prompted. Do not ask me to paste credentials or tokens into chat.

## Codex CLI

```bash
codex plugin marketplace add wilbe-developer/wilber-agent-access
codex plugin add wilber-agent-access@wilbe
```

Codex opens Wilbe in the browser when authorization is required. Sign in with your own Wilbe account and approve the connection.

## Verify Wilber

Start a new task and ask:

```text
Show my Wilber identity, projects, permissions and available workflows.
```

The client uses OAuth in the browser. No access token is copied into chat or stored by the plugin.

The bundled `wilber` CLI remains available for complete workflow exports and local workflow editing. Its first protected command can be authorized with:

```bash
wilber auth login
wilber doctor
```

That login also opens Wilbe in the browser and stores the resulting OAuth grant in the operating system credential store. It does not ask for a token. `wilber auth login --manual` remains available only as an explicit compatibility fallback for clients that cannot complete browser authorization.

## Versioning and provenance

Wilbe publishes versioned Git history and release tags in this repository. The authenticated ZIP available in Wilbe Profile Settings is a fallback build of the same source and includes `RELEASE.json` with the originating platform commit.
