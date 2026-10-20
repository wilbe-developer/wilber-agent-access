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

After installation, open a fresh task when Codex requires one. In that task, resolve the plugin's source path and run its bundled command for your role: `bin/wilber auth login --audience founder` for a portfolio founder, `bin/wilber auth login --audience captain` for a Captain, or `bin/wilber auth login` for a team member. Codex opens Wilbe in the browser. Sign in with your own Wilbe account and approve the connection, then run `bin/wilber doctor`.

## Verify Wilber

Start a new task and ask:

```text
Show my Wilber identity, permissions and available tools. Help me choose one useful first task within that access.
```

The plugin shares one browser-approved credential between its MCP tools and CLI. It is stored privately on the device and is never copied into chat.

Portfolio founders run `wilber auth login --audience founder`; Captains run `wilber auth login --audience captain`. Sign in with your own Wilbe account, review the permission checklist and approve. The resulting connection lasts 30 days and is limited by both your selected permissions and your current Wilbe access. Revoke it at any time in Profile Settings > AI access. Reviewed submissions enter Wilbe's review queue before any CRM merge or outreach.

The bundled `wilber` CLI remains available for complete workflow exports and local workflow editing. It uses the same authorization as the plugin connection:

```bash
wilber auth login
wilber doctor
```

The team login above opens Wilbe in the browser and stores the resulting OAuth grant in the operating system credential store. The local MCP proxy reads the same grant. It does not ask for a token. `wilber auth login --manual` remains available only as an explicit compatibility fallback for clients that cannot complete browser authorization.

## Versioning and provenance

Wilbe publishes versioned Git history and release tags in this repository. The authenticated ZIP available in Wilbe Profile Settings is a fallback build of the same source and includes `RELEASE.json` with the originating platform commit.

### Platform tools

With explicit connection approval, founders and Captains can use their permitted platform work through MCP. Own and shared Build work, profiles and settings, learning, private community resources, notifications, offers and Captain operational tools keep their current role and resource checks. Every new permission requires fresh browser approval. Existing connections keep their approved access.

Private messages can be read, drafted and sent on the member's instruction. Ongoing private participation requires a named audience, purpose, send limit and expiry, and is off by default. Forum publishing follows the member's instruction. Reading does not mark a message seen. Adding people or sharing earlier history requires a separate explicit choice.

Use `wilber files upload` with the listed preparation tool and reviewed target arguments to transfer local files privately. The server checks actual bytes before attachment. A verified upload may still need its separately authorised message send. Keep the original file and request ID after interruption. Current platform limits and any existing intentional public sharing apply. The older `wilber build upload` remains a self-only compatibility command with its original 4 MiB limit.

Use `wilber account export --output <private-local.json>` to save your own export with private file permissions. Passwords, verification codes and file bytes stay out of chat. Provider sign-in, email verification, device permissions and external event registration retain their normal ceremonies.

Wiki resources include source links and opaque attachment references. Entitled private PDFs and permitted files use short-lived read links. Arbitrary storage paths are not accepted. Never publish or persist a temporary link; cite its source page and file label.
