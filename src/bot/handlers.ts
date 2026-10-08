import path from "node:path";
import { Markup } from "telegraf";
import {
  buildPlanPrompt,
  extractCommandPayload,
  suggestClosestWord
} from "./commandUtils.js";
import {
  normalizeLanguage,
  SUPPORTED_LANGUAGES,
  t,
  type Locale
} from "./i18n.js";
import { escapeMarkdownV2, splitTelegramMessage } from "./formatter.js";
import type { Scheduler } from "../cron/scheduler.js";
import { toErrorMessage } from "../lib/errors.js";
import type { Router } from "../orchestrator/router.js";
import type { PtyManager } from "../runner/ptyManager.js";
import type {
  ShellExecutionResult,
  ShellManager
} from "../runner/shellManager.js";
import type { DevServerManager } from "../runner/devServerManager.js";
import type { SkillRegistry } from "../orchestrator/skillRegistry.js";
import type { MemoryScope, MemoryStore } from "../memory/memoryStore.js";
import type { CodexSmithAccessState } from "./accessContext.js";
import { AccessGuard } from "../access/guard.js";
import {
  CAPABILITY_COMMANDS,
  type Capability
} from "../access/capabilities.js";
import type { AccessPolicy, AccessPolicyStore } from "../access/policy.js";
import { isPathInside } from "../lib/paths.js";

interface SkillResultPayload {
  text?: string;
  testJobId?: string;
  switchToRepo?: string;
}

interface RegisterHandlersOptions {
  bot: any;
  router: Router;
  ptyManager: PtyManager;
  shellManager: ShellManager;
  devServerManager: DevServerManager;
  skills: Record<string, any>;
  skillRegistry: SkillRegistry;
  scheduler: Scheduler;
  memoryStore?: MemoryStore;
  accessGuard?: AccessGuard;
  accessPolicy?: AccessPolicyStore;
  adminActions?: {
    restart?: () => Promise<void>;
  };
}

const GITHUB_REQUEST_CAPABILITIES: Record<string, Capability> = {
  help: "gh.read",
  read: "gh.read",
  test: "gh.test",
  write: "gh.write",
  confirm: "gh.write"
};

const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;

function mcpCapability(text: string): Capability {
  const subcommand = text
    .replace(/^\/mcp(@\w+)?\s*/i, "")
    .trim()
    .split(/\s+/)[0]
    ?.toLowerCase();
  if (subcommand === "call") return "mcp.call";
  if (/^(enable|disable|reconnect)$/.test(subcommand || "")) {
    return "mcp.manage";
  }
  return "mcp.read";
}

function formatRepoScope(entries: string[]): string {
  return entries.includes("*") ? "*" : entries.join(", ");
}

function formatAccessSummary(policy: AccessPolicy): string[] {
  const roles = [...policy.roles.values()].map(
    (role) => `- ${role.name}: ${role.description || "(no description)"}`
  );
  const groups = [...policy.groups.entries()].map(
    ([id, group]) =>
      `- ${id}: maxRole=${group.maxRole || "-"}, defaultRole=${group.defaultRole || "-"}, conversation=${group.conversation}, repos=${formatRepoScope(group.repos)}`
  );
  return [
    `Access policy: ${policy.source}`,
    `Users: ${policy.users.size}`,
    `Unlisted groups: ${policy.settings.unknownGroups}`,
    `Denied feedback: private=${policy.settings.deny.privateChats}, groups=${policy.settings.deny.groups}`,
    `Audit: ${policy.settings.audit}`,
    "Roles:",
    ...roles,
    "Groups:",
    ...(groups.length ? groups : ["- (none)"])
  ];
}

function accessStateOf(ctx: any): CodexSmithAccessState {
  const access = ctx.state?.codexSmith as CodexSmithAccessState | undefined;
  if (!access) throw new Error("Telegram access context is unavailable.");
  return access;
}

function formatMemoryScope(scope: MemoryScope): string {
  if (scope.skill) return `skill:${scope.skill}`;
  if (scope.projectPath) return `project:${scope.projectPath}`;
  if (scope.conversationKey) return `conversation:${scope.conversationKey}`;
  return "user";
}

async function sendChunkedMarkdown(
  ctx: any,
  text: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  const markdown = escapeMarkdownV2(text);
  const chunks = splitTelegramMessage(markdown, 3900);

  for (let i = 0; i < chunks.length; i += 1) {
    await ctx.reply(chunks[i], {
      parse_mode: "MarkdownV2",
      disable_web_page_preview: true,
      ...extra
    });
  }
}

async function sendSkillResult(
  ctx: any,
  result: string | SkillResultPayload,
  locale: Locale = "en"
): Promise<void> {
  const payload = typeof result === "string" ? { text: result } : result;
  const text = payload?.text || t(locale, "emptyResponse");
  const markdown = escapeMarkdownV2(text);
  const chunks = splitTelegramMessage(markdown, 3900);

  for (let i = 0; i < chunks.length; i += 1) {
    const maybeMarkup =
      i === chunks.length - 1 && payload.testJobId
        ? Markup.inlineKeyboard([
            Markup.button.callback(
              t(locale, "buttonRefreshTestStatus"),
              `gh:test_status:${payload.testJobId}`
            )
          ])
        : undefined;

    await ctx.reply(chunks[i], {
      parse_mode: "MarkdownV2",
      disable_web_page_preview: true,
      ...(maybeMarkup ? maybeMarkup : {})
    });
  }
}

async function applySkillResult(
  ctx: any,
  result: string | SkillResultPayload,
  locale: Locale,
  ptyManager: PtyManager
): Promise<void> {
  const payload = typeof result === "string" ? { text: result } : { ...result };

  if (payload.switchToRepo) {
    try {
      ptyManager.switchWorkdir(ctx.chat.id, payload.switchToRepo);
    } catch (error) {
      const suffix = t(locale, "repoSwitchFailed", {
        error: toErrorMessage(error)
      });
      payload.text = payload.text ? `${payload.text}\n\n${suffix}` : suffix;
    }
  }

  await sendSkillResult(ctx, payload, locale);
}

function formatProjectLines(
  projects: Array<{ path: string; relativePath: string; name?: string }>,
  currentWorkdir: string
): string[] {
  return projects.map((project) => {
    const marker = project.path === currentWorkdir ? " <current>" : "";
    return `- ${project.relativePath}${marker}`;
  });
}

function formatSkillLines(
  skillStates: Array<{ name: string; enabled: boolean }>
): string[] {
  return skillStates.map(
    (skill) => `- ${skill.name}: ${skill.enabled ? "on" : "off"}`
  );
}

function suggestProjectName(
  input: string,
  projects: Array<{ relativePath: string; name?: string }>
): string | null {
  const candidates = [
    ...new Set(
      projects
        .flatMap((project) => [project.relativePath, project.name])
        .filter(Boolean) as string[]
    )
  ];

  const threshold = Math.min(
    6,
    Math.max(2, Math.ceil(String(input || "").trim().length * 0.35))
  );

  return suggestClosestWord(input, candidates, threshold);
}

function extractCloneTarget(
  result: Pick<
    ShellExecutionResult,
    "status" | "command" | "output" | "workdir"
  >
): string | null {
  if (
    result.status !== "passed" ||
    !result.command ||
    !result.output ||
    !result.workdir ||
    !/^git\s+clone(?:\s|$)/i.test(result.command)
  ) {
    return null;
  }

  const match = result.output.match(/Cloning into '([^']+)'\.\.\./i);
  if (!match?.[1]) {
    return null;
  }

  return path.resolve(result.workdir, match[1]);
}

function buildShellSuccessFollowUp(
  locale: Locale,
  result: Pick<
    ShellExecutionResult,
    "status" | "command" | "output" | "workdir"
  >,
  workspaceRoot: string
): string | null {
  const cloneTarget = extractCloneTarget(result);
  if (!cloneTarget) {
    return null;
  }

  const relativePath = path.relative(workspaceRoot, cloneTarget) || ".";
  const repoCommand = isPathInside(workspaceRoot, cloneTarget)
    ? `/repo ${relativePath}`
    : "";

  return t(locale, "shellCloneSucceeded", {
    relativePath,
    workdir: cloneTarget,
    repoCommand
  });
}

export function registerHandlers({
  bot,
  router,
  ptyManager,
  shellManager,
  devServerManager,
  skills,
  skillRegistry,
  scheduler,
  memoryStore,
  accessGuard,
  accessPolicy,
  adminActions
}: RegisterHandlersOptions): void {
  const localeOf = (chatId: string | number): Locale =>
    ptyManager.getLanguage(chatId);
  const guard = accessGuard || new AccessGuard();
  const allow = (ctx: any, capability: Capability): Promise<boolean> =>
    guard.require(ctx, capability, localeOf(ctx.chat.id));
  const allowCurrentWorkdir = (ctx: any): Promise<boolean> =>
    guard.requireWorkdir(
      ctx,
      ptyManager.getStatus(ctx.chat.id),
      localeOf(ctx.chat.id)
    );
  const handlePromptResult = async (
    ctx: any,
    locale: Locale,
    result:
      | Awaited<ReturnType<PtyManager["sendPrompt"]>>
      | Awaited<ReturnType<PtyManager["continuePendingPrompt"]>>,
    {
      announceContinue = false
    }: {
      announceContinue?: boolean;
    } = {}
  ): Promise<void> => {
    if (result.started) {
      if (announceContinue) {
        await sendChunkedMarkdown(
          ctx,
          t(locale, "continueStarted", { mode: result.mode })
        );
      }
      return;
    }

    if (result.reason === "workspace_busy") {
      await sendChunkedMarkdown(
        ctx,
        t(locale, "workspaceContention", {
          relativeWorkdir: result.relativeWorkdir,
          mode: result.activeMode || "unknown",
          blockingChatId: result.blockingChatId,
          continueCommand: "/continue"
        })
      );
      return;
    }

    if (result.reason === "no_pending_prompt") {
      await sendChunkedMarkdown(ctx, t(locale, "continueNothingPending"));
      return;
    }

    if (result.reason === "profile_mismatch") {
      await sendChunkedMarkdown(ctx, t(locale, "codexProfileMismatch"));
      return;
    }

    await sendChunkedMarkdown(
      ctx,
      t(locale, "taskBusy", { mode: result.activeMode || "unknown" })
    );
  };

  bot.start(async (ctx: any) => {
    if (!(await allow(ctx, "bot.status"))) return;
    await sendChunkedMarkdown(
      ctx,
      t(localeOf(ctx.chat.id), "startLines").join("\n")
    );
  });

  bot.command("help", async (ctx: any) => {
    if (!(await allow(ctx, "bot.status"))) return;
    await sendChunkedMarkdown(
      ctx,
      t(localeOf(ctx.chat.id), "helpLines").join("\n")
    );
  });

  bot.command("status", async (ctx: any) => {
    if (!(await allow(ctx, "bot.status"))) return;
    const locale = localeOf(ctx.chat.id);
    const status = ptyManager.getStatus(ctx.chat.id);
    const skillStates = skillRegistry.list(ctx.chat.id);
    const mcpServers = skills.mcp.mcpClient.listServers();
    const shellSummary = shellManager.isEnabled()
      ? `enabled, ${shellManager.isReadOnly() ? "read-only" : "writable"} (${shellManager.getAllowedCommands().length} prefixes)`
      : "disabled";
    const skillsSummary =
      skillStates
        .map(
          (skill: { name: string; enabled: boolean }) =>
            `${skill.name}:${skill.enabled ? "on" : "off"}`
        )
        .join(", ") || "none";
    const mcpSummary = mcpServers.length
      ? mcpServers
          .map(
            (server: { name: string; enabled: boolean; connected: boolean }) =>
              `${server.name}:${server.enabled ? "on" : "off"}/${server.connected ? "up" : "down"}`
          )
          .join(", ")
      : "none";
    await sendChunkedMarkdown(
      ctx,
      t(locale, "statusLines", {
        status,
        recentProjects:
          ptyManager
            .getRecentProjects(ctx.chat.id)
            .map((item) => item.relativePath)
            .join(", ") || ".",
        shellSummary,
        skillsSummary,
        mcpSummary
      }).join("\n")
    );
  });

  bot.command("pwd", async (ctx: any) => {
    if (!(await allow(ctx, "bot.status"))) return;
    const status = ptyManager.getStatus(ctx.chat.id);
    await sendChunkedMarkdown(
      ctx,
      t(localeOf(ctx.chat.id), "pwdLines", {
        status,
        recent:
          ptyManager
            .getRecentProjects(ctx.chat.id)
            .map((item) => item.relativePath)
            .join(", ") || "."
      }).join("\n")
    );
  });

  bot.command("repo", async (ctx: any) => {
    const locale = localeOf(ctx.chat.id);
    const payload = extractCommandPayload(ctx.message.text, "repo");
    const listing = !payload || /^recent$/i.test(payload);
    if (!(await allow(ctx, listing ? "repo.list" : "repo.switch"))) return;
    const status = ptyManager.getStatus(ctx.chat.id);
    const visible = (project: { path: string }): boolean =>
      guard.isWorkdirAllowed(ctx, status.workspaceRoot, project.path);

    if (!payload) {
      const projects = ptyManager.listProjects().filter(visible);
      const recent = ptyManager.getRecentProjects(ctx.chat.id).filter(visible);
      const lines = formatProjectLines(projects, status.workdir);
      const recentLines = recent.map((project) => `- ${project.relativePath}`);

      await sendChunkedMarkdown(
        ctx,
        t(locale, "repoList", {
          workspaceRoot: status.workspaceRoot,
          projectLines: lines,
          recentLines
        })
      );
      return;
    }

    if (/^recent$/i.test(payload)) {
      const recent = ptyManager
        .getRecentProjects(ctx.chat.id)
        .filter(visible)
        .map((project) => `- ${project.relativePath}`);
      await sendChunkedMarkdown(
        ctx,
        t(locale, "repoRecent", {
          recentLines: recent
        })
      );
      return;
    }

    try {
      let target = payload;
      if (payload === "-") {
        const previous = ptyManager.peekPreviousWorkdir(ctx.chat.id);
        if (previous && !visible({ path: previous })) {
          throw new Error(
            t(locale, "accessRepoDenied", {
              value: path.relative(status.workspaceRoot, previous) || "."
            })
          );
        }
      } else {
        const projects = ptyManager.listProjects().filter(visible);
        const exact = projects.find(
          (project) =>
            project.relativePath === payload || project.name === payload
        );

        if (!exact) {
          const lowerPayload = payload.toLowerCase();
          const matches = projects.filter((project) =>
            project.relativePath.toLowerCase().includes(lowerPayload)
          );

          if (!matches.length) {
            const suggestion = suggestProjectName(payload, projects);
            if (suggestion) {
              throw new Error(
                t(locale, "repoSuggestion", { value: payload, suggestion })
              );
            }

            throw new Error(t(locale, "repoNoMatch", { value: payload }));
          }

          if (matches.length > 1) {
            await sendChunkedMarkdown(
              ctx,
              t(locale, "repoMultipleMatches", {
                value: payload,
                projectLines: formatProjectLines(matches, status.workdir)
              })
            );
            return;
          }

          target = matches[0].relativePath;
        }
      }

      const result =
        target === "-"
          ? ptyManager.switchToPreviousWorkdir(ctx.chat.id)
          : ptyManager.switchWorkdir(ctx.chat.id, target);
      await sendChunkedMarkdown(
        ctx,
        t(locale, "repoSwitched", {
          relativePath: result.relativePath,
          workdir: result.workdir
        })
      );
    } catch (error) {
      await sendChunkedMarkdown(
        ctx,
        t(locale, "repoSwitchFailed", { error: toErrorMessage(error) })
      );
    }
  });

  bot.command("skill", async (ctx: any) => {
    const locale = localeOf(ctx.chat.id);
    const payload = extractCommandPayload(ctx.message.text, "skill");
    const listing = !payload || /^(list|status)$/i.test(payload);
    if (!(await allow(ctx, listing ? "bot.status" : "skills.manage"))) return;
    if (listing) {
      await sendChunkedMarkdown(
        ctx,
        t(locale, "skillList", {
          skillLines: formatSkillLines(skillRegistry.list(ctx.chat.id))
        })
      );
      return;
    }

    const [action, rawName] = payload.split(/\s+/, 2);
    if (!/^(on|off)$/i.test(action) || !rawName) {
      await sendChunkedMarkdown(ctx, t(locale, "skillUsage"));
      return;
    }

    try {
      const actionResult = /^on$/i.test(action)
        ? skillRegistry.enable(ctx.chat.id, rawName)
        : skillRegistry.disable(ctx.chat.id, rawName);
      if (/^on$/i.test(action)) {
        await sendChunkedMarkdown(
          ctx,
          t(locale, "skillStateChanged", {
            name: rawName,
            enabled: true,
            changed: actionResult.changed,
            skillLines: formatSkillLines(actionResult.skills)
          })
        );
        return;
      }

      await sendChunkedMarkdown(
        ctx,
        t(locale, "skillStateChanged", {
          name: rawName,
          enabled: false,
          changed: actionResult.changed,
          skillLines: formatSkillLines(actionResult.skills)
        })
      );
    } catch (error) {
      await sendChunkedMarkdown(
        ctx,
        t(locale, "skillManagementFailed", { error: toErrorMessage(error) })
      );
    }
  });

  bot.command("memory", async (ctx: any) => {
    if (!(await allow(ctx, "memory.use"))) return;
    if (!memoryStore?.isEnabled()) {
      await sendChunkedMarkdown(ctx, "Memory is disabled.");
      return;
    }

    try {
      const access = accessStateOf(ctx);
      const payload = extractCommandPayload(ctx.message.text, "memory");
      const [action = "list", ...tail] = payload.split(/\s+/);

      if (/^(list|status)$/i.test(action)) {
        const entries = memoryStore.list(access.userId);
        const lines = entries
          .slice(-30)
          .map(
            (entry) =>
              `- ${entry.id.slice(0, 8)} [${entry.status}] [${formatMemoryScope(entry.scope)}] ${entry.content}`
          );
        await sendChunkedMarkdown(
          ctx,
          [
            "Memory:",
            ...(lines.length ? lines : ["- (empty)"]),
            "",
            "Usage: /memory remember [--global|--project|--skill name] <text> | /memory approve|reject|forget <id>"
          ].join("\n")
        );
        return;
      }

      if (/^(approve|reject|forget)$/i.test(action)) {
        const id = tail[0] || "";
        if (!id) throw new Error(`Usage: /memory ${action} <id>`);
        if (/^approve$/i.test(action)) {
          const entry = await memoryStore.approve(access.userId, id);
          await sendChunkedMarkdown(
            ctx,
            `Memory ${entry.id.slice(0, 8)} approved. It will be eligible for the next new Codex thread.`
          );
          return;
        }
        if (/^reject$/i.test(action)) {
          await memoryStore.reject(access.userId, id);
        } else {
          await memoryStore.forget(access.userId, id);
        }
        await sendChunkedMarkdown(ctx, `Memory ${id} removed.`);
        return;
      }

      if (!/^remember$/i.test(action)) {
        throw new Error(
          "Usage: /memory list | /memory remember [--global|--project|--skill name] <text> | /memory approve|reject|forget <id>"
        );
      }

      const scope: MemoryScope = { ownerUserId: access.userId };
      let contentParts = [...tail];
      const scopeFlag = contentParts[0]?.toLowerCase();
      if (scopeFlag === "--global") {
        contentParts = contentParts.slice(1);
      } else if (scopeFlag === "--project") {
        scope.projectPath = ptyManager.getStatus(ctx.chat.id).workdir;
        contentParts = contentParts.slice(1);
      } else if (scopeFlag === "--skill") {
        const skill = contentParts[1];
        if (!skill)
          throw new Error("Usage: /memory remember --skill <name> <text>");
        scope.skill = skill.toLowerCase();
        contentParts = contentParts.slice(2);
      } else {
        scope.conversationKey = access.conversationKey;
      }

      const proposal = await memoryStore.propose(scope, contentParts.join(" "));
      const state = proposal.duplicate
        ? "already exists"
        : proposal.entry.status === "pending"
          ? "staged; approve it with /memory approve " +
            proposal.entry.id.slice(0, 8)
          : "saved";
      await sendChunkedMarkdown(
        ctx,
        `Memory ${proposal.entry.id.slice(0, 8)} ${state}. Scope: ${formatMemoryScope(proposal.entry.scope)}.`
      );
    } catch (error) {
      await sendChunkedMarkdown(
        ctx,
        `Memory update failed: ${toErrorMessage(error)}`
      );
    }
  });

  bot.command("new", async (ctx: any) => {
    if (!(await allow(ctx, "codex.prompt"))) return;
    const result = ptyManager.resetCurrentProjectConversation(ctx.chat.id);
    await sendChunkedMarkdown(
      ctx,
      t(localeOf(ctx.chat.id), "conversationReset", { closed: result.closed })
    );
  });

  bot.command("restart", async (ctx: any) => {
    if (!(await allow(ctx, "bot.restart"))) return;
    const locale = localeOf(ctx.chat.id);
    if (!adminActions?.restart) {
      await sendChunkedMarkdown(ctx, t(locale, "restartUnavailable"));
      return;
    }

    await sendChunkedMarkdown(ctx, t(locale, "restarting"));
    await adminActions.restart();
  });

  bot.command("exec", async (ctx: any) => {
    if (!(await allow(ctx, "codex.exec"))) return;
    const locale = localeOf(ctx.chat.id);
    const task = extractCommandPayload(ctx.message.text, "exec");
    if (!task) {
      await sendChunkedMarkdown(ctx, t(locale, "usageExec"));
      return;
    }
    if (!(await allowCurrentWorkdir(ctx))) return;

    const result = await ptyManager.sendPrompt(ctx, task, {
      forceExec: true,
      notice: t(locale, "execNotice")
    });

    await handlePromptResult(ctx, locale, result);
  });

  bot.command("sh", async (ctx: any) => {
    if (!(await allow(ctx, "shell.run"))) return;
    const locale = localeOf(ctx.chat.id);
    const command = extractCommandPayload(ctx.message.text, "sh");
    if (!command) {
      await sendChunkedMarkdown(ctx, t(locale, "usageSh"));
      return;
    }

    const status = ptyManager.getStatus(ctx.chat.id);
    if (status.active) {
      await sendChunkedMarkdown(ctx, t(locale, "codexBusyForShell"));
      return;
    }

    let validation;
    try {
      validation = shellManager.inspectCommand(command, { locale });
    } catch (error) {
      await sendChunkedMarkdown(ctx, toErrorMessage(error));
      return;
    }

    if (validation.dangerous && !(await allow(ctx, "shell.confirm"))) return;

    if (validation.requiresConfirmation) {
      await sendChunkedMarkdown(
        ctx,
        t(locale, "shellRequiresConfirmation", {
          command: validation.commandText,
          confirmationCommand: validation.confirmationCommand
        })
      );
      return;
    }

    if (!(await allowCurrentWorkdir(ctx))) return;

    await sendChunkedMarkdown(
      ctx,
      t(locale, "runningSafeShell", {
        workdir: status.workdir,
        command: validation.argv.join(" ")
      })
    );

    const result = await shellManager.execute({
      chatId: ctx.chat.id,
      rawCommand: command,
      workdir: status.workdir,
      locale
    });

    if (!result.started) {
      await sendChunkedMarkdown(ctx, t(locale, "shellBusy"));
      return;
    }

    await sendChunkedMarkdown(ctx, t(locale, "shellResult", { result }));

    const followUp = buildShellSuccessFollowUp(
      locale,
      result,
      status.workspaceRoot
    );
    if (followUp) {
      await sendChunkedMarkdown(ctx, followUp);
    }
  });

  bot.command("dev", async (ctx: any) => {
    const locale = localeOf(ctx.chat.id);
    const payload = extractCommandPayload(ctx.message.text, "dev");
    const subcommand = (payload || "status").trim().toLowerCase();
    const capability: Capability = /^(start|stop)$/.test(subcommand)
      ? "dev.run"
      : "dev.read";
    if (!(await allow(ctx, capability))) return;
    if (!(await allowCurrentWorkdir(ctx))) return;
    const runtimeStatus = ptyManager.getStatus(ctx.chat.id);
    const workdir = runtimeStatus.workdir;
    const relativeWorkdir = runtimeStatus.relativeWorkdir;

    if (!subcommand || subcommand === "status") {
      const devStatus = devServerManager.getStatus(workdir);
      await sendChunkedMarkdown(
        ctx,
        t(locale, "devStatus", {
          devStatus,
          relativeWorkdir
        })
      );
      return;
    }

    if (subcommand === "start") {
      const result = await devServerManager.start({
        workdir,
        chatId: ctx.chat.id
      });

      if (result.started) {
        await sendChunkedMarkdown(
          ctx,
          t(locale, "devStarted", {
            command: result.command,
            scriptName: result.scriptName,
            relativeWorkdir
          })
        );
        return;
      }

      if (result.reason === "already_running") {
        await sendChunkedMarkdown(
          ctx,
          t(locale, "devAlreadyRunning", {
            relativeWorkdir,
            startedByChatId: result.status.startedByChatId || "unknown",
            command: result.status.command || "unknown"
          })
        );
        return;
      }

      if (result.reason === "no_package_json") {
        await sendChunkedMarkdown(
          ctx,
          t(locale, "devNoPackageJson", { relativeWorkdir })
        );
        return;
      }

      if (result.reason === "no_script") {
        await sendChunkedMarkdown(
          ctx,
          t(locale, "devNoScript", {
            relativeWorkdir,
            availableScripts: result.availableScripts.join(", ") || "(none)"
          })
        );
        return;
      }

      await sendChunkedMarkdown(
        ctx,
        t(locale, "devSpawnFailed", { error: result.error })
      );
      return;
    }

    if (subcommand === "stop") {
      const stopped = devServerManager.stop(workdir);
      await sendChunkedMarkdown(
        ctx,
        t(locale, stopped ? "devStopped" : "devNotRunning", {
          relativeWorkdir
        })
      );
      return;
    }

    if (subcommand === "logs") {
      await sendChunkedMarkdown(
        ctx,
        t(locale, "devLogs", {
          relativeWorkdir,
          logs: devServerManager.getLogs(workdir)
        })
      );
      return;
    }

    if (subcommand === "url") {
      const url = devServerManager.getUrl(workdir);
      await sendChunkedMarkdown(
        ctx,
        t(locale, url ? "devUrl" : "devNoUrl", {
          relativeWorkdir,
          url: url || ""
        })
      );
      return;
    }

    await sendChunkedMarkdown(ctx, t(locale, "usageDev"));
  });

  bot.command("auto", async (ctx: any) => {
    if (!(await allow(ctx, "codex.auto"))) return;
    const locale = localeOf(ctx.chat.id);
    const task = extractCommandPayload(ctx.message.text, "auto");
    if (!task) {
      await sendChunkedMarkdown(ctx, t(locale, "usageAuto"));
      return;
    }
    if (!(await allowCurrentWorkdir(ctx))) return;

    const result = await ptyManager.sendPrompt(ctx, task, {
      forceExec: true,
      fullAuto: true,
      notice: t(locale, "autoNotice")
    });

    await handlePromptResult(ctx, locale, result);
  });

  bot.command("plan", async (ctx: any) => {
    if (!(await allow(ctx, "codex.plan"))) return;
    const locale = localeOf(ctx.chat.id);
    const task = extractCommandPayload(ctx.message.text, "plan");
    if (!task) {
      await sendChunkedMarkdown(ctx, t(locale, "usagePlan"));
      return;
    }
    if (!(await allowCurrentWorkdir(ctx))) return;

    const result = await ptyManager.sendPrompt(ctx, buildPlanPrompt(task), {
      forceExec: true,
      notice: t(locale, "planNotice")
    });

    await handlePromptResult(ctx, locale, result);
  });

  bot.command("continue", async (ctx: any) => {
    if (!(await allow(ctx, "codex.prompt"))) return;
    const pending = ptyManager.peekPendingPrompt(ctx.chat.id);
    if (pending?.fullAuto && !(await allow(ctx, "codex.auto"))) return;
    if (pending && !(await allowCurrentWorkdir(ctx))) return;
    const locale = localeOf(ctx.chat.id);
    const result = await ptyManager.continuePendingPrompt(ctx);
    await handlePromptResult(ctx, locale, result, {
      announceContinue: true
    });
  });

  bot.command("model", async (ctx: any) => {
    const locale = localeOf(ctx.chat.id);
    const value = extractCommandPayload(ctx.message.text, "model");
    if (!(await allow(ctx, value ? "codex.model" : "bot.status"))) return;
    if (!value) {
      const status = ptyManager.getStatus(ctx.chat.id);
      await sendChunkedMarkdown(
        ctx,
        t(locale, "modelCurrent", { model: status.preferredModel })
      );
      return;
    }

    if (/^(reset|default|inherit)$/i.test(value)) {
      ptyManager.clearPreferredModel(ctx.chat.id);
      const closed = ptyManager.closeSession(ctx.chat.id);
      await sendChunkedMarkdown(ctx, t(locale, "modelReset", { closed }));
      return;
    }

    if (!MODEL_NAME_PATTERN.test(value)) {
      await sendChunkedMarkdown(ctx, t(locale, "modelInvalid"));
      return;
    }

    ptyManager.setPreferredModel(ctx.chat.id, value);
    const closed = ptyManager.closeSession(ctx.chat.id);
    await sendChunkedMarkdown(ctx, t(locale, "modelSet", { value, closed }));
  });

  bot.command("verbose", async (ctx: any) => {
    const locale = localeOf(ctx.chat.id);
    const value = extractCommandPayload(ctx.message.text, "verbose");
    if (!(await allow(ctx, value ? "bot.preferences" : "bot.status"))) return;
    if (!value) {
      await sendChunkedMarkdown(
        ctx,
        t(locale, "verboseCurrent", {
          enabled: ptyManager.isVerbose(ctx.chat.id)
        })
      );
      return;
    }

    if (/^(on|true|1)$/i.test(value)) {
      ptyManager.setVerbose(ctx.chat.id, true);
      await sendChunkedMarkdown(
        ctx,
        t(locale, "verboseSet", { enabled: true })
      );
      return;
    }

    if (/^(off|false|0)$/i.test(value)) {
      ptyManager.setVerbose(ctx.chat.id, false);
      await sendChunkedMarkdown(
        ctx,
        t(locale, "verboseSet", { enabled: false })
      );
      return;
    }

    await sendChunkedMarkdown(ctx, t(locale, "usageVerbose"));
  });

  bot.command("language", async (ctx: any) => {
    const currentLocale = localeOf(ctx.chat.id);
    const value = extractCommandPayload(ctx.message.text, "language");
    if (!(await allow(ctx, value ? "bot.preferences" : "bot.status"))) return;
    if (!value) {
      await sendChunkedMarkdown(
        ctx,
        t(currentLocale, "languageCurrent", {
          language: currentLocale
        })
      );
      return;
    }

    const normalized = normalizeLanguage(value);
    if (!normalized || !SUPPORTED_LANGUAGES.includes(normalized)) {
      await sendChunkedMarkdown(ctx, t(currentLocale, "languageInvalid"));
      return;
    }

    ptyManager.setLanguage(ctx.chat.id, normalized);
    await sendChunkedMarkdown(
      ctx,
      t(normalized, "languageSet", {
        language: normalized
      })
    );
  });

  bot.command("interrupt", async (ctx: any) => {
    if (!(await allow(ctx, "codex.prompt"))) return;
    const ok = ptyManager.interrupt(ctx.chat.id);
    await sendChunkedMarkdown(
      ctx,
      t(localeOf(ctx.chat.id), "interruptResult", { ok })
    );
  });

  bot.command("stop", async (ctx: any) => {
    if (!(await allow(ctx, "codex.prompt"))) return;
    const ok = ptyManager.closeSession(ctx.chat.id);
    await sendChunkedMarkdown(
      ctx,
      t(localeOf(ctx.chat.id), "stopResult", { ok })
    );
  });

  bot.command("cron_now", async (ctx: any) => {
    if (!(await allow(ctx, "bot.cron"))) return;
    const locale = localeOf(ctx.chat.id);
    try {
      await scheduler.triggerDailySummaryNow(ctx.from.id);
      await sendChunkedMarkdown(ctx, t(locale, "cronTriggered"));
    } catch (error) {
      await sendChunkedMarkdown(
        ctx,
        t(locale, "triggerFailed", { error: toErrorMessage(error) })
      );
    }
  });

  bot.command("gh", async (ctx: any) => {
    const locale = localeOf(ctx.chat.id);
    if (!skillRegistry.isEnabled(ctx.chat.id, "github")) {
      await sendChunkedMarkdown(ctx, t(locale, "githubDisabled"));
      return;
    }

    try {
      const text = extractCommandPayload(ctx.message.text, "gh") || "help";
      const kind = skills.github.classifyRequest(`/gh ${text}`);
      if (!(await allow(ctx, GITHUB_REQUEST_CAPABILITIES[kind]))) return;
      if (
        (kind === "test" || kind === "write") &&
        !(await allowCurrentWorkdir(ctx))
      ) {
        return;
      }
      const result = await skills.github.execute({
        text: `/gh ${text}`,
        chatId: ctx.chat.id,
        workdir: ptyManager.getStatus(ctx.chat.id).workdir,
        locale
      });
      await applySkillResult(ctx, result, locale, ptyManager);
    } catch (error) {
      await sendChunkedMarkdown(
        ctx,
        t(locale, "githubFailed", { error: toErrorMessage(error) })
      );
    }
  });

  bot.command("mcp", async (ctx: any) => {
    const locale = localeOf(ctx.chat.id);
    if (!skillRegistry.isEnabled(ctx.chat.id, "mcp")) {
      await sendChunkedMarkdown(ctx, t(locale, "mcpDisabled"));
      return;
    }

    try {
      const text = ctx.message.text.trim();
      if (!(await allow(ctx, mcpCapability(text)))) return;
      const result = await skills.mcp.execute({ text, ctx, locale });
      await applySkillResult(ctx, result, locale, ptyManager);
    } catch (error) {
      await sendChunkedMarkdown(
        ctx,
        t(locale, "mcpFailed", { error: toErrorMessage(error) })
      );
    }
  });

  bot.command("whoami", async (ctx: any) => {
    if (!(await allow(ctx, "bot.status"))) return;
    const locale = localeOf(ctx.chat.id);
    const access = accessStateOf(ctx);
    const grant = access.grant;
    if (!grant) return;
    await sendChunkedMarkdown(
      ctx,
      t(locale, "whoamiLines", {
        userId: grant.userId,
        chatId: grant.chatId,
        kind: grant.kind,
        role: grant.roleLabel,
        userRepos: formatRepoScope(grant.userRepos),
        chatRepos: formatRepoScope(grant.chatRepos),
        sandbox: grant.codex.sandbox || "default",
        approval: grant.codex.approval || "default",
        network:
          grant.codex.network === undefined
            ? "default"
            : String(grant.codex.network),
        commandLines: grant.capabilities.map(
          (capability) => `- ${capability}: ${CAPABILITY_COMMANDS[capability]}`
        )
      }).join("\n")
    );
  });

  bot.command("access", async (ctx: any) => {
    if (!(await allow(ctx, "access.manage"))) return;
    const locale = localeOf(ctx.chat.id);
    const payload = extractCommandPayload(ctx.message.text, "access");
    if (!accessPolicy) {
      await sendChunkedMarkdown(ctx, t(locale, "accessUnavailable"));
      return;
    }

    if (/^reload$/i.test(payload)) {
      try {
        const policy = accessPolicy.reload();
        await sendChunkedMarkdown(
          ctx,
          [t(locale, "accessReloaded"), ...formatAccessSummary(policy)].join(
            "\n"
          )
        );
      } catch (error) {
        await sendChunkedMarkdown(
          ctx,
          t(locale, "accessReloadFailed", { error: toErrorMessage(error) })
        );
      }
      return;
    }

    if (payload) {
      await sendChunkedMarkdown(ctx, t(locale, "usageAccess"));
      return;
    }

    await sendChunkedMarkdown(
      ctx,
      formatAccessSummary(accessPolicy.get()).join("\n")
    );
  });

  bot.on("callback_query", async (ctx: any) => {
    const locale = localeOf(ctx.chat.id);
    const data = ctx.callbackQuery?.data || "";
    if (!data.startsWith("gh:test_status:")) return;
    if (!(await allow(ctx, "gh.read"))) return;

    const jobId = data.replace("gh:test_status:", "");
    const result = await skills.github.getTestStatus(jobId, locale);
    await ctx.answerCbQuery(t(locale, "callbackRefreshed"));

    if (!result) {
      await sendChunkedMarkdown(ctx, t(locale, "testJobNotFound", { jobId }));
      return;
    }

    await sendSkillResult(ctx, result, locale);
  });

  bot.on("text", async (ctx: any) => {
    const text = ctx.message.text?.trim() || "";
    const locale = localeOf(ctx.chat.id);
    if (!text) return;
    if (/^(重启\s*bot|重启机器人|restart bot)$/i.test(text)) {
      await sendChunkedMarkdown(ctx, t(locale, "useRestartCommand"));
      return;
    }
    if (/^\/\s+\S+/.test(text)) {
      await sendChunkedMarkdown(
        ctx,
        t(locale, "slashSpaceError", {
          fixed: text.replace(/^\/\s+/, "/")
        })
      );
      return;
    }
    if (text.startsWith("/")) return;

    try {
      const route = await router.routeMessage(text, {
        chatId: ctx.chat.id
      });
      if (route.target === "pty") {
        if (!(await allow(ctx, "codex.prompt"))) return;
        if (!(await allowCurrentWorkdir(ctx))) return;
        const result = await ptyManager.sendPrompt(ctx, route.prompt);
        await handlePromptResult(ctx, locale, result);
        return;
      }

      const kind =
        route.skill === "github"
          ? skills.github.classifyRequest(route.payload)
          : null;
      const capability: Capability = kind
        ? GITHUB_REQUEST_CAPABILITIES[kind]
        : "mcp.read";
      if (!(await allow(ctx, capability))) return;
      if (kind === "test" && !(await allowCurrentWorkdir(ctx))) return;

      const skill = skills[route.skill];
      if (!skill) {
        await sendChunkedMarkdown(
          ctx,
          t(locale, "skillNotFound", { name: route.skill })
        );
        return;
      }

      const result = await skill.execute({
        text: route.payload,
        chatId: ctx.chat.id,
        workdir: ptyManager.getStatus(ctx.chat.id).workdir,
        locale
      });
      await applySkillResult(ctx, result, locale, ptyManager);
    } catch (error) {
      await sendChunkedMarkdown(
        ctx,
        t(locale, "processingFailed", { error: toErrorMessage(error) })
      );
    }
  });
}
