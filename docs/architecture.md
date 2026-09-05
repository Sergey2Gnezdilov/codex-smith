# Codex Smith Architecture

Codex Smith is a local-first personal Codex agent controlled through Telegram. Its
design goal is durable personal context without turning the bot into a large hosted
platform. The default deployment is one Node.js process, the Codex CLI/SDK, and
small local state files. Docker, Redis, a vector database, and a separate auth
service are not required.

## Trust Model

Access is denied unless the Telegram sender ID is explicitly allowed. Usernames,
display names, group membership, forwarded-message authors, and chat invite links
are never authorization signals.

There are three user sets:

- `ALLOWED_USER_IDS`: users allowed in direct messages and groups.
- `GROUP_ALLOWED_USER_IDS`: additional users allowed only inside groups.
- `ADMIN_USER_IDS`: users allowed to invoke high-risk operational commands.

If `ADMIN_USER_IDS` is omitted, only the first `ALLOWED_USER_IDS` entry becomes the
administrator. Multi-user deployments should always set it explicitly.

`ADMIN_ONLY_COMMANDS` defaults to `restart,auto,sh,dev,cron_now,gh,mcp`. Group
messages must address the bot by command, mention, reply, or callback unless
`GROUP_REQUIRE_MENTION=false` is explicitly selected.

## Conversation Identity

Telegram delivery identity and agent conversation identity are different values:

```text
direct message       -> dm:<user-id>
group, default       -> group:<chat-id>:user:<user-id>
group, shared opt-in -> group:<chat-id>
```

The Telegram chat ID is used only to deliver output. The conversation key owns the
selected repository, Codex thread ID, model, language, verbosity, pending request,
skill switches, and running-job locks. This prevents two allowed users in one group
from accidentally resuming each other's Codex thread.

Shared group context is deliberately opt-in with
`GROUP_CONVERSATION_SCOPE=shared`. It should be used only when every allowed group
member is meant to see and influence the same agent history.

## Memory Model

The planned memory engine follows a bounded, scoped, local-first model:

```text
user profile (small, always eligible)
  + conversation memory (matching Telegram conversation only)
  + project memory (matching repository only)
  + skill memory (matching active skill only)
  -> frozen snapshot when a new Codex thread starts
```

Every memory record has an owner user ID and may additionally have a conversation,
project, and skill scope. Retrieval is an intersection, not a union: a GitHub skill
memory record must not enter a general coding prompt, and one user's record must
never enter another user's context.

The first local implementation uses an atomic JSON store with bounded character
budgets and deterministic scope/recency ranking. This avoids native database
bindings and external services. The storage API remains isolated so SQLite FTS or
another local history index can be added later without changing Telegram or Codex
code.

Memory writes are staged by default. The user sees the proposed record and approves
or rejects it. Before persistence, content is checked for duplicates, likely
secrets, invisible Unicode, and common prompt-injection patterns. Stored memory is
rendered as untrusted reference data, never as system instructions.

Full transcripts are not injected into every prompt. Codex owns its resumable thread
history; historical search is an explicit tool or command. A compact memory snapshot
is injected only when a new thread starts, which keeps context stable and avoids
repeated token cost.

## Skills And Plugins

Skills are routing and context packages. They should declare:

- a stable name and version;
- commands or routing hints;
- required permissions and secrets;
- their memory namespace and budget;
- whether they can write memory;
- whether activation or installation requires an administrator.

Plugins are capability packages that may contribute skills, MCP servers, or local
commands. Installation, upgrade, and removal are admin-only and should use a staged
flow: inspect manifest, show permissions and source, approve, install atomically,
then health-check. Secrets remain in environment variables or an OS credential
store, never in plugin state or memory.

## Lightweight Deployment

The baseline remains:

```text
Telegram -> access middleware -> router -> Codex SDK
                           \-> explicit skill/plugin adapter

local files: runtime state + curated memory + audit log
```

One process is the supported default. Writes use temporary files plus atomic rename.
Repository write contention is still serialized by working directory. Optional
providers can be added later, but the core must remain useful without them.

## Delivery Phases

1. **Access and identity (implemented)**: per-user group lanes, separate group-only users,
   administrators, mention gating, and admin-only commands.
2. **Curated memory (implemented baseline)**: local store, scoped retrieval, write approval, `/memory`
   management, and new-thread snapshots.
3. **History search**: bounded local transcript index queried only on demand.
4. **Plugin lifecycle**: manifest validation, permission preview, staged install,
   health check, and rollback.
5. **Operational hardening**: structured audit events, backup/restore, migration
   checks, and Telegram forum-topic awareness.

## Design References

- [Hermes persistent memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/)
- [Hermes skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/)
- [Hermes Telegram gateway](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/telegram/)
- [OpenAI Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)
- [OpenAI Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
