# Operations Guide

## Process Supervision

The recommended production supervisor is PM2. This bot uses Telegram long polling, so run exactly one instance per bot token.

`ecosystem.config.ts` is the source of truth. Start PM2 through `ecosystem.config.cjs`, which is a thin compatibility shim for PM2's config loader.

Start:

```bash
npm install
cp .env.example .env
pm2 start ecosystem.config.cjs
```

Common PM2 commands:

```bash
pm2 status codex-smith
pm2 logs codex-smith
pm2 restart codex-smith
pm2 stop codex-smith
pm2 save
```

## Health Checks

Static health check:

```bash
npm run healthcheck
```

Strict health check:

```bash
npm run healthcheck:strict
```

Optional Telegram live check:

```bash
npm run healthcheck:strict
npm run healthcheck:live
```

Use your own local `.env` values or CI secrets for live checks. Do not commit or paste live output that includes bot usernames, chat IDs, or Codex thread IDs.

What the health check validates:

- workspace and runner directories exist
- the state file directory is writable
- the configured Codex command can be resolved
- `node-pty` helper permissions are valid
- optional live Telegram API authentication

## Deployment Notes

- Keep exactly one polling process per bot token.
- Stop the old `CodexClaw` PM2 process before starting `codex-smith`; two polling processes cannot share one bot token.
- If you also use Codex directly in a terminal, run that work in a separate git worktree. The bot only detects conflicts with other bot-managed chats, not external terminal sessions.
- Run the bot under a restricted system user.
- Keep `.env` outside version control.
- Let each operator configure live-check credentials locally after startup instead of sharing one checked-in identity.
- Rotate Telegram and GitHub tokens if they are ever exposed.
- If you reinstall dependencies on macOS, rerun `npm run healthcheck`; the bot now auto-repairs `node-pty` helper permissions on startup.

## Migration From CodexClaw

The default state path is now `.codex-smith-state.json`. When `STATE_FILE` is unset,
Codex Smith automatically uses `.codex-telegram-claws-state.json` if that legacy file
already exists and the new file does not. Stop the bot before moving or renaming a
state file.
