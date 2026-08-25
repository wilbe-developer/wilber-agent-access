# Wilber CLI reference

## Authentication and diagnostics

```bash
wilber auth login
wilber auth status
wilber auth logout
wilber whoami
wilber doctor
```

`wilber auth login` opens Wilbe in the browser and stores the OAuth grant in macOS Keychain when available. `WILBER_ACCESS_TOKEN` is supported for temporary and automated sessions. Never pass a token as a command-line argument. Use `wilber auth login --manual` only when browser authorization is unavailable and an administrator explicitly approves the compatibility fallback.

## Workflows

```bash
wilber workflows list
wilber workflows inspect <workflow-key-or-id>
wilber workflows export <workflow-key-or-id> --out <directory>
wilber workflows fork <workflow-key-or-id> --out <directory> [--name <name>]
wilber workflows validate <directory>
wilber workflows propose <directory> --yes
```

`export` produces a read-only local snapshot. `fork` creates the member's private no-effect draft and materializes it locally. `validate` synchronizes changed files to that draft before running server-side validation. `propose` validates again, then submits the draft for Jesse's review.

Use `--json` when structured output is needed. Use `--force` only when the requested output directory may be replaced safely.

## Public-source demand research

```bash
wilber demand campaigns
wilber demand search "query" [--campaign <id>] [--grade <grade>] [--limit <n>]
wilber demand person <id>
```

These commands return only the caller's permitted projection. They do not expose private messages or contact details.

## Bounded work

```bash
wilber request submit --capability research --objective "Objective"
wilber request status <request-id>
wilber request continue <request-id> --instruction "Missing input" --client-request-id <stable-id>
```

Allowed capabilities are `research`, `workflow_experiment`, `data_question`, and `process_improvement`. A request does not authorize external effects.

Wilber administrators can start an isolated durable task for an exact workflow:

```bash
wilber request admin-submit --workflow <workflow-key> --objective "Objective" --mode read_only
wilber request admin-submit --workflow <workflow-key> --objective "Objective" --mode workflow_authorized --workspace wilbe_process
```

The approved workspace values are `none`, `wilbe_process`, `wilbe_cos`, and `shared_skills`. Use `wilber-cos-general` only when no narrower workflow applies. `workflow_authorized` permits only the requested effects allowed by the canonical workflow and its normal gates.

## Approved media credentials

Special Projects members normally receive `media.credentials.read` as part of the approved media lane. Confirm the live permission before installing the shared media credentials:

```bash
wilber media credentials install
wilber media credentials status
```

Use `--accounts opus,descript,youtube` to choose a subset and `--force` only when the member has asked to replace an existing local installation. The command creates a short-lived device key, receives an encrypted package from the Mac mini, decrypts it locally, writes private `0600` files, and immediately erases the server-side ciphertext. The private device key is never written to disk. Never print or read back the installed values into the conversation.

Opus and Descript variables are installed in `~/.config/wilber/media/credentials.env`. Load them for a local shell command with:

```bash
set -a; source ~/.config/wilber/media/credentials.env; set +a
```

YouTube OAuth files are installed under `~/.wilbe/youtube/`. Their scopes are limited to YouTube and read-only YouTube Analytics.
