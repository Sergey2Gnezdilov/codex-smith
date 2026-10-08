# Access Control

Codex Smith decides what each Telegram user may do from an access policy. The
policy maps users and group chats to roles, roles to capabilities, and limits
every user to a set of repositories under `WORKSPACE_ROOT`. The same policy sets
the Codex sandbox for each role, so a group can mix read-only askers with
developers who let Codex change files.

Everything not granted is denied: an unlisted user, an unlisted group, a missing
capability, or a repository outside the user's scope.

## Quick Start

```bash
cp access-policy.example.json access-policy.json
# edit user ids, group ids, roles and repositories
echo "ACCESS_POLICY_FILE=access-policy.json" >> .env
npm run start
```

After editing the file, send `/access reload` as an admin. A file that fails
validation is rejected and the previous policy stays active.

Use `/whoami` to see your role, repository scope, Codex sandbox and allowed
commands in the current chat.

## Capabilities

Every command, plain-text prompt and inline button checks one capability before
it runs. Subcommands are checked separately, so `/gh test status` and
`/gh push` need different capabilities.

| Capability        | Unlocks                                                         |
| ----------------- | --------------------------------------------------------------- |
| `bot.status`      | `/start`, `/help`, `/status`, `/pwd`, `/whoami`, `/skill list`  |
| `bot.preferences` | `/language <code>`, `/verbose on`, `/verbose off`               |
| `bot.restart`     | `/restart`                                                      |
| `bot.cron`        | `/cron_now`                                                     |
| `repo.list`       | `/repo`, `/repo recent`                                         |
| `repo.switch`     | `/repo <name>`, `/repo -`                                       |
| `codex.prompt`    | plain text to Codex, `/new`, `/continue`, `/interrupt`, `/stop` |
| `codex.plan`      | `/plan`                                                         |
| `codex.exec`      | `/exec`                                                         |
| `codex.auto`      | `/auto` (approval policy `never`)                               |
| `codex.model`     | `/model <name>`, `/model reset`                                 |
| `memory.use`      | `/memory`                                                       |
| `shell.run`       | `/sh`                                                           |
| `shell.confirm`   | `/sh --confirm` for commands in `SHELL_DANGEROUS_COMMANDS`      |
| `dev.read`        | `/dev status`, `/dev logs`, `/dev url`                          |
| `dev.run`         | `/dev start`, `/dev stop`                                       |
| `gh.read`         | `/gh help`, `/gh test status`, the refresh button               |
| `gh.test`         | `/gh run tests`, plain-text test requests                       |
| `gh.write`        | `/gh commit`, `/gh push`, `/gh create repo`, `/gh confirm`      |
| `mcp.read`        | `/mcp list`, `/mcp status`, `/mcp tools`                        |
| `mcp.call`        | `/mcp call`                                                     |
| `mcp.manage`      | `/mcp enable`, `/mcp disable`, `/mcp reconnect`                 |
| `skills.manage`   | `/skill on`, `/skill off`                                       |
| `access.manage`   | `/access`, `/access reload`                                     |

In role definitions a capability can be written exactly (`gh.test`), as a
namespace (`gh.*`), as everything (`*`), or negated with `!` (`!gh.write`).
Negations win over grants and are inherited.

## Built-in Roles

| Role        | Inherits    | Adds                                                                                                    | Codex sandbox     |
| ----------- | ----------- | ------------------------------------------------------------------------------------------------------- | ----------------- |
| `viewer`    | -           | `bot.status`, `bot.preferences`, `repo.list`, `repo.switch`, `codex.prompt`, `codex.plan`, `memory.use` | `read-only`       |
| `developer` | `viewer`    | `codex.exec`, `codex.model`, `gh.read`, `dev.read`, `mcp.read`                                          | `workspace-write` |
| `operator`  | `developer` | `dev.run`, `shell.run`, `gh.test`, `mcp.call`                                                           | inherited         |
| `admin`     | `operator`  | `*`                                                                                                     | inherited         |

A policy file can redefine a built-in role by using the same name, or add new
roles.

## Policy File Reference

The file is JSON. Keys starting with `_` are ignored, which allows comments.
Unknown keys, unknown capabilities and unknown role names are errors.

### `settings`

| Key                            | Values                 | Default                    | Meaning                                               |
| ------------------------------ | ---------------------- | -------------------------- | ----------------------------------------------------- |
| `deny.privateChats`            | `notice`, `silent`     | `notice`                   | Reply to a refused command in a private chat          |
| `deny.groups`                  | `notice`, `silent`     | `silent`                   | Reply to a refused command in a group                 |
| `deny.cooldownSeconds`         | number                 | `60`                       | Minimum time between refusal notices per conversation |
| `audit`                        | `off`, `denied`, `all` | `denied`                   | Which decisions are written to the log                |
| `unknownGroups`                | `deny`, `allow`        | `deny`                     | Whether groups missing from `groups` are served       |
| `groupDefaults.conversation`   | `per-user`, `shared`   | `GROUP_CONVERSATION_SCOPE` | Default conversation scope for groups                 |
| `groupDefaults.requireMention` | boolean                | `GROUP_REQUIRE_MENTION`    | Default mention requirement for groups                |

A repository scope refusal always replies, because the user holds the
capability and needs to know to switch repositories.

### `roles.<name>`

| Key              | Meaning                                                               |
| ---------------- | --------------------------------------------------------------------- |
| `inherits`       | Parent role; capabilities, negations and Codex settings are inherited |
| `description`    | Shown by `/access`                                                    |
| `capabilities`   | List of capability patterns                                           |
| `codex.sandbox`  | `read-only`, `workspace-write`, `danger-full-access`                  |
| `codex.approval` | `untrusted`, `on-request`, `on-failure`, `never`                      |
| `codex.network`  | Network access inside the sandbox (SDK backend)                       |

Role Codex settings override `CODEX_SDK_SANDBOX_MODE`,
`CODEX_SDK_APPROVAL_POLICY` and `CODEX_SDK_NETWORK_ACCESS_ENABLED` for that role.
Settings the role does not define fall back to those variables.

### `users.<telegram user id>`

Either a role name (`"123": "developer"`) or an object:

| Key           | Default  | Meaning                                                                              |
| ------------- | -------- | ------------------------------------------------------------------------------------ |
| `role`        | required | Role name                                                                            |
| `repos`       | `["*"]`  | Repository paths relative to `WORKSPACE_ROOT`; a path also covers its subdirectories |
| `privateChat` | `true`   | `false` limits the user to group chats                                               |
| `name`        | -        | Free text for readers of the file                                                    |

### `groups.<telegram chat id>`

Group ids are negative numbers. Only listed groups are served unless
`settings.unknownGroups` is `allow`.

| Key              | Default                        | Meaning                                                                                  |
| ---------------- | ------------------------------ | ---------------------------------------------------------------------------------------- |
| `maxRole`        | none                           | Upper bound: members only keep capabilities this role also has                           |
| `defaultRole`    | none                           | Role for members who are not listed in `users`; without it they are ignored              |
| `repos`          | `["*"]`                        | Repositories usable in this group                                                        |
| `conversation`   | `groupDefaults.conversation`   | `per-user` gives each member an own Codex thread; `shared` gives one thread to the group |
| `requireMention` | `groupDefaults.requireMention` | Only react to commands, replies to the bot and `@bot` mentions                           |
| `name`           | -                              | Free text for readers of the file                                                        |

## Resolution Rules

1. Private chat: the user must be listed and have `privateChat` not set to
   `false`. The user's role applies.
2. Group: the group must be listed (or `unknownGroups` is `allow`). Messages not
   directed at the bot are dropped before any user check when `requireMention`
   is on. The role is the user's role, or the group's `defaultRole` for unlisted
   members.
3. With `maxRole`, the effective capabilities are the intersection of the
   user's role and `maxRole`, and each Codex setting takes the stricter of the
   two (`read-only` before `workspace-write`, network off before on). `/whoami`
   shows this as `admin (capped by developer)`.
4. The repository scope is the intersection of the user's `repos` and the
   group's `repos`.
5. Before Codex, `/sh`, `/dev` or GitHub test and write actions run, the current
   repository must be inside that scope. `/repo` only lists and switches to
   repositories inside it.

## Workspace Boundaries

Containment checks resolve symlinks, so a link inside `WORKSPACE_ROOT` that
points elsewhere is treated as outside. At startup the bot warns when
`CODEX_WORKDIR` or `GITHUB_DEFAULT_WORKDIR` lies outside `WORKSPACE_ROOT`; new
conversations start in `CODEX_WORKDIR`, so keep it inside the root.

## Operations

- `/whoami` shows the effective role, scopes, Codex settings and allowed commands.
- `/access` shows the policy source, roles and groups; `/access reload` re-reads
  the file.
- Log lines look like
  `[access] deny user=234567890 chat=-1001234567890 role=viewer gh.write`.
  Message text is never logged.
- The bot logs each unlisted group once, which helps to find a new group id.

## Legacy Mode

Without `ACCESS_POLICY_FILE` the bot builds a policy from the old variables:
users in `ADMIN_USER_IDS` get `admin`, other users in `ALLOWED_USER_IDS` and
`GROUP_ALLOWED_USER_IDS` get `member` (everything except the capabilities behind
`ADMIN_ONLY_COMMANDS` and `access.manage`), users only in
`GROUP_ALLOWED_USER_IDS` cannot use private chats, any group is served, refusals
are silent, and Codex keeps the sandbox from the environment. The startup log
warns that unlisted groups are accepted in this mode.

## Limits

- Codex sandbox modes limit writes and network access. They do not confine
  reads to the repository, so anyone with `codex.prompt` can ask Codex about any
  file the bot's OS user can read. Run the bot under a dedicated OS user that
  can only read the workspace and its own configuration.
- `dev.run`, `shell.run` and `gh.test` start processes outside the Codex sandbox
  that execute code from the repository, for example `package.json` scripts and
  test configuration. Grant them only to people who could run that code on the
  host anyway.
- In a `shared` group conversation members with different roles use one Codex
  thread, so a lower role can read what a higher role produced there. Prefer
  `per-user` when roles differ.
- With the CLI backend the network setting is not applied, and an interactive
  PTY session keeps the sandbox it was started with; a request from a different
  profile is refused until `/stop`.
- The Telegram command menu still lists every command; the bot enforces access
  when a command arrives.
