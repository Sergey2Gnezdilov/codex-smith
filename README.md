# Codex Smith

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js 20.19+](https://img.shields.io/badge/node-20.19%2B-green.svg)](https://nodejs.org/)

Your local Codex agent, available from Telegram.

Codex Smith is a self-hosted Telegram control plane for OpenAI Codex. It keeps the
agent on your machine, scopes conversations to a Telegram chat and repository, and
streams progress back to your phone. The official Codex SDK is the primary runtime;
`codex exec` and the legacy PTY path remain available as fallbacks.

This is the `0.3.0` reboot of the former CodexClaw fork. The new name drops “Cloud”
and “Claw”: Smith is the operator persona, while Codex remains the product core.

## What It Does

- Starts, continues, and resumes Codex threads from Telegram
- Keeps conversation state isolated by `user + chat + repository`
- Supports safe direct-message and multi-user group modes
- Switches safely between repositories below one configured workspace root
- Streams final answers, progress, diffs, commands, MCP activity, and web-search events
- Prevents two bot-managed chats from writing to the same working directory concurrently
- Exposes explicit GitHub and MCP control paths
- Supports scheduled summaries and a restricted, opt-in shell
- Runs with an allowlist, `workspace-write`, network disabled, and approval-on-request by default

## Architecture

```text
Telegram
  -> user-ID access and admin middleware
  -> command/router layer
     -> Codex SDK thread (default)
     -> codex exec or CLI/PTy (fallback)
     -> explicit GitHub or MCP skill
  -> streamed Telegram response
```

The SDK still controls a local Codex installation. Codex authentication and runtime
configuration remain owned by Codex; the bot does not require copied access tokens.

## Requirements

- Node.js 20.19 or newer
- A working Codex CLI installation
- A Telegram bot token from `@BotFather`
- Your numeric Telegram user ID for the allowlist

Verify Codex before starting the bot:

```bash
codex --version
codex login
```

## Quick Start

```bash
git clone https://github.com/Sergey2Gnezdilov/codex-smith.git
cd codex-smith
npm install
cp .env.example .env
```

Set the minimum configuration in `.env`:

```bash
BOT_TOKEN=123456789:telegram-token-from-botfather
ALLOWED_USER_IDS=123456789
GROUP_ALLOWED_USER_IDS=
ADMIN_USER_IDS=123456789
GROUP_REQUIRE_MENTION=true
GROUP_CONVERSATION_SCOPE=per-user
WORKSPACE_ROOT=/absolute/path/to/your/projects
CODEX_WORKDIR=/absolute/path/to/your/projects/default-project
CODEX_BACKEND=sdk
STATE_FILE=.codex-smith-state.json
```

Start the bot:

```bash
npm run start
```

For development with automatic restart:

```bash
npm run dev
```

## Telegram Commands

Core workflow:

- `/start` — show the bootstrap message
- `/help` — show command help
- `/status` — show runner, repository, model, and workflow state
- `/pwd` — show the selected working directory
- `/repo` — list repositories below `WORKSPACE_ROOT`
- `/repo <name>` — switch repository
- `/repo recent` — list recently used repositories
- `/repo -` — switch back to the previous repository
- `/new` — clear the saved conversation for the selected repository
- `/memory list` — inspect your own approved and pending memory
- `/memory remember [--global|--project|--skill name] <text>` — stage a scoped memory
- `/memory approve|reject|forget <id>` — manage a staged or stored memory
- `/model [name|reset]` — inspect or override the model for this chat
- `/language [en|zh|zh-HK]` — set bot language
- `/verbose [on|off]` — toggle detailed progress events

Codex execution:

- Send ordinary text to continue the persistent Codex thread
- `/exec <task>` — run one stateless Codex task
- `/auto <task>` — run one stateless task without approval prompts inside the configured sandbox
- `/plan <task>` — ask for a plan without direct file changes
- `/continue` — explicitly continue a request blocked by a same-workdir conflict
- `/interrupt` — interrupt the active Codex turn
- `/stop` — terminate the active Codex run

Tools and operations:

- `/skill list|on|off` — inspect or change bot-side skill routing
- `/mcp ...` — explicit bot-side MCP operations
- `/gh ...` — explicit GitHub operations with confirmation for writes
- `/dev start|stop|status|logs|url` — manage a repository's frontend dev server
- `/sh <command>` — run a configured allowlisted command when enabled
- `/cron_now` — run the scheduled summary immediately
- `/restart` — restart the bot process

## Security Defaults

Codex Smith is a remote-control surface for a coding agent. Treat it like SSH access:

- Keep `ALLOWED_USER_IDS` narrow and never run without it
- Put group-only users in `GROUP_ALLOWED_USER_IDS`, not `ALLOWED_USER_IDS`
- Keep `GROUP_REQUIRE_MENTION=true` and the default per-user group context
- Keep high-risk commands in `ADMIN_ONLY_COMMANDS`
- Keep `SHELL_ENABLED=false` unless the shell channel is necessary
- Keep `CODEX_SDK_SANDBOX_MODE=workspace-write`
- Keep `CODEX_SDK_APPROVAL_POLICY=on-request`
- Keep `CODEX_SDK_NETWORK_ACCESS_ENABLED=false` unless a task needs network access
- Scope `WORKSPACE_ROOT` to projects the bot is allowed to inspect or change
- Run one polling process per Telegram bot token
- Never commit `.env`, bot tokens, GitHub tokens, state files, logs, or session output

Optional restricted shell configuration:

```bash
SHELL_ENABLED=true
SHELL_READ_ONLY=true
SHELL_ALLOWED_COMMANDS=["pwd","ls","git status","git diff --stat","npm test","npm run check"]
SHELL_DANGEROUS_COMMANDS=["git add","git commit","git push","rm","mv","cp","npm publish"]
```

See [SECURITY.md](SECURITY.md) and [docs/operations.md](docs/operations.md) before
running the bot continuously.

## Runtime Configuration

Important Codex settings:

```bash
CODEX_BACKEND=sdk
CODEX_COMMAND=codex
CODEX_SDK_CONFIG={}
CODEX_SDK_SKIP_GIT_REPO_CHECK=true
CODEX_SDK_SANDBOX_MODE=workspace-write
CODEX_SDK_APPROVAL_POLICY=on-request
CODEX_SDK_REASONING_EFFORT=
CODEX_SDK_NETWORK_ACCESS_ENABLED=false
CODEX_SDK_WEB_SEARCH_MODE=
CODEX_SDK_ADDITIONAL_DIRECTORIES=[]
```

Telegram proxy support:

```bash
TELEGRAM_API_BASE=https://api.telegram.org
TELEGRAM_PROXY_URL=
```

Multi-user access control:

```bash
ALLOWED_USER_IDS=123456789
GROUP_ALLOWED_USER_IDS=987654321
ADMIN_USER_IDS=123456789
ADMIN_ONLY_COMMANDS=restart,auto,sh,dev,cron_now,gh,mcp
GROUP_REQUIRE_MENTION=true
GROUP_CONVERSATION_SCOPE=per-user
MEMORY_ENABLED=true
MEMORY_REQUIRE_APPROVAL=true
```

In the default `per-user` mode, every allowed group member gets an independent Codex
thread and bot state. Use `shared` only for a deliberately collaborative group.

Curated memory is stored locally in `.codex-smith-memory.json`. New records are
pending by default and enter context only after `/memory approve`. Approved records
are selected by user, conversation, and repository, then included as a bounded
untrusted-data snapshot only when a new Codex thread starts. Skill-scoped records
remain excluded until a matching skill provider explicitly requests them. Use `/new`
when you intentionally want an updated snapshot.

MCP servers are configured as JSON. Coding prompts go directly to Codex so Codex can
use its own MCP configuration. Bot-side MCP is invoked only through `/mcp`, avoiding
duplicate tool calls and duplicate context.

## State Migration From CodexClaw

The new default state file is `.codex-smith-state.json`. If `STATE_FILE` is not set,
the new file does not exist, and `.codex-telegram-claws-state.json` is present, Codex
Smith automatically continues using the legacy file. You can keep that path or move
it while the bot is stopped and set `STATE_FILE` explicitly.

## Development And Release Checks

```bash
npm run check
npm run lint
npm run format:check
npm test
npm run healthcheck
```

Run live checks only with operator-owned local credentials:

```bash
npm run healthcheck:live
npm run telegram:smoke
```

See [docs/release.md](docs/release.md) for the release gate.
The memory, access, and plugin direction is specified in
[docs/architecture.md](docs/architecture.md).

## Project Status

`0.3.0` is the first Codex Smith release candidate. The current implementation is a
strong single-host beta. Multi-host control, durable queues, richer approval UX, and
formal observability remain future work.

## License And Origin

Codex Smith is distributed under the MIT License. It is derived from
[MackDing/CodexClaw](https://github.com/MackDing/CodexClaw), which was itself inspired
by `RichardAtCT/claude-code-telegram`. Original copyright notices are retained in
[LICENSE](LICENSE).
