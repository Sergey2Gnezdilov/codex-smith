---
name: Codex Smith
description: Install and operate a secure Telegram control plane for local Codex agents, repository switching, MCP, GitHub actions, and scheduled automation.
---

# Codex Smith

## Purpose

Use Codex from Telegram while the agent and project files remain on an operator-owned
machine. Prefer the Codex SDK backend; use `codex exec` or PTY mode only as a fallback.

## Install

```bash
git clone https://github.com/Sergey2Gnezdilov/codex-smith.git
cd codex-smith
npm install
cp .env.example .env
```

## Minimum Configuration

```bash
BOT_TOKEN=123456789:telegram-token
ALLOWED_USER_IDS=123456789
STATE_FILE=.codex-smith-state.json
WORKSPACE_ROOT=/absolute/path/to/projects
CODEX_WORKDIR=/absolute/path/to/projects/default-project
CODEX_BACKEND=sdk
```

Keep shell execution disabled, use `workspace-write`, keep network access off by
default, and scope `WORKSPACE_ROOT` narrowly.

## Start And Verify

```bash
npm run start
npm run check
npm run lint
npm run format:check
npm test
npm run healthcheck
```

## Telegram Quick Use

```text
/status
/repo
/repo my-project
/new
/model
/dev status
/gh create repo my-new-repo
/gh confirm
```

GitHub writes require explicit `/gh` commands and confirmation. `/sh` is a separate,
restricted operator channel and is disabled by default.
