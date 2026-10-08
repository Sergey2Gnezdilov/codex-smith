import test from "node:test";
import assert from "node:assert/strict";
import { registerHandlers } from "../src/bot/handlers.js";
import { CAPABILITIES, type Capability } from "../src/access/capabilities.js";
import type { AccessGrant } from "../src/access/policy.js";
import { GitHubSkill } from "../src/orchestrator/skills/githubSkill.js";

type Handler = (ctx: TestContext) => Promise<void> | void;

interface ReplyRecord {
  text: string;
  options?: Record<string, unknown>;
}

interface TestContext {
  state: {
    codexSmith: {
      userId: string;
      chatId: string;
      conversationKey: string;
      isAdmin: boolean;
      grant?: AccessGrant;
    };
  };
  chat: {
    id: number;
  };
  from: {
    id: number;
  };
  message: {
    text: string;
  };
  callbackQuery?: {
    data?: string;
  };
  replies: ReplyRecord[];
  reply: (text: string, options?: Record<string, unknown>) => Promise<void>;
  answerCbQuery: (text?: string) => Promise<void>;
}

class FakeBot {
  readonly commands = new Map<string, Handler>();
  readonly events = new Map<string, Handler>();
  startHandler: Handler | null = null;

  start(handler: Handler): void {
    this.startHandler = handler;
  }

  command(name: string, handler: Handler): void {
    this.commands.set(name, handler);
  }

  on(event: string, handler: Handler): void {
    this.events.set(event, handler);
  }
}

function createGrant(overrides: Partial<AccessGrant> = {}): AccessGrant {
  return {
    userId: "1",
    chatId: "1",
    kind: "private",
    role: "admin",
    roleLabel: "admin",
    capabilities: [...CAPABILITIES],
    userRepos: ["*"],
    chatRepos: ["*"],
    codex: {},
    denyFeedback: "notice",
    audit: "off",
    cooldownSeconds: 0,
    ...overrides
  };
}

function grantWithout(...denied: Capability[]): AccessGrant {
  return createGrant({
    role: "viewer",
    roleLabel: "viewer",
    capabilities: CAPABILITIES.filter((cap) => !denied.includes(cap))
  });
}

function createContext(
  text: string,
  chatId = 1,
  grant: AccessGrant = createGrant()
): TestContext {
  const replies: ReplyRecord[] = [];
  return {
    state: {
      codexSmith: {
        userId: String(chatId),
        chatId: String(chatId),
        conversationKey: `dm:${chatId}`,
        isAdmin: grant.capabilities.includes("access.manage"),
        grant
      }
    },
    chat: {
      id: chatId
    },
    from: {
      id: chatId
    },
    message: {
      text
    },
    replies,
    reply: async (replyText: string, options?: Record<string, unknown>) => {
      replies.push({
        text: replyText,
        options
      });
    },
    answerCbQuery: async () => {}
  };
}

function createDependencies(
  overrides: {
    sendPrompt?: () => Promise<unknown>;
    continuePendingPrompt?: () => Promise<unknown>;
    routeMessage?: (text: string) => Promise<unknown>;
    githubExecute?: () => Promise<unknown>;
    shellInspect?: () => Record<string, unknown>;
    shellExecute?: () => Promise<Record<string, unknown>>;
    getStatus?: () => Record<string, unknown>;
    switchWorkdir?: (chatId: string | number, target: string) => unknown;
    devStart?: () => Promise<unknown>;
    devStatus?: () => Record<string, unknown>;
    devStop?: () => boolean;
    devLogs?: () => string;
    devUrl?: () => string | null;
    memoryStore?: Record<string, unknown>;
    listProjects?: () => Array<{
      name: string;
      path: string;
      relativePath: string;
    }>;
    peekPendingPrompt?: () => { workdir: string; fullAuto: boolean } | null;
    restart?: () => Promise<void>;
  } = {}
) {
  const githubClassifier = new GitHubSkill({
    config: {
      github: {
        token: "",
        defaultWorkdir: process.cwd(),
        defaultBranch: "main",
        e2eCommand: "echo test"
      },
      workspace: { root: process.cwd() }
    }
  });
  const bot = new FakeBot();
  const ptyManager = {
    getLanguage: () => "en",
    sendPrompt:
      overrides.sendPrompt ||
      (async () => ({
        started: true,
        mode: "sdk"
      })),
    continuePendingPrompt:
      overrides.continuePendingPrompt ||
      (async () => ({
        started: true,
        mode: "sdk"
      })),
    getStatus:
      overrides.getStatus ||
      (() => ({
        backend: "sdk",
        active: false,
        activeMode: null,
        lastMode: null,
        lastExitCode: null,
        lastExitSignal: null,
        projectSessionId: null,
        preferredModel: null,
        language: "en",
        verboseOutput: false,
        ptySupported: null,
        workdir: process.cwd(),
        relativeWorkdir: ".",
        workspaceRoot: process.cwd(),
        command: "codex",
        mcpServers: [],
        workflowSystem: "superpowers",
        workflowPhase: "none"
      })),
    getRecentProjects: () => [],
    listProjects: overrides.listProjects || (() => []),
    peekPendingPrompt: overrides.peekPendingPrompt || (() => null),
    peekPreviousWorkdir: () => null,
    setPreferredModel: () => null,
    closeSession: () => false,
    switchWorkdir:
      overrides.switchWorkdir ||
      (() => ({
        workdir: process.cwd(),
        relativePath: "."
      }))
  };

  registerHandlers({
    bot,
    router: {
      routeMessage:
        overrides.routeMessage ||
        (async (text: string) => ({
          target: "pty" as const,
          prompt: text
        }))
    } as any,
    ptyManager: ptyManager as any,
    shellManager: {
      isEnabled: () => false,
      isReadOnly: () => true,
      getAllowedCommands: () => [],
      inspectCommand:
        overrides.shellInspect ||
        (() => {
          throw new Error("not used");
        }),
      execute:
        overrides.shellExecute ||
        (async () => ({ started: false, reason: "busy" }))
    } as any,
    devServerManager: {
      start:
        overrides.devStart ||
        (async () => ({
          started: true,
          scriptName: "dev",
          packageManager: "npm",
          command: "npm run dev"
        })),
      getStatus:
        overrides.devStatus ||
        (() => ({
          running: false,
          status: "stopped",
          workdir: process.cwd(),
          startedByChatId: null,
          command: null,
          packageManager: null,
          scriptName: null,
          pid: null,
          startedAt: null,
          exitedAt: null,
          exitCode: null,
          signal: null,
          detectedUrl: null
        })),
      stop: overrides.devStop || (() => false),
      getLogs: overrides.devLogs || (() => "(no logs yet)"),
      getUrl: overrides.devUrl || (() => null)
    } as any,
    skills: {
      github: {
        execute: overrides.githubExecute || (async () => ({ text: "unused" })),
        classifyRequest: (text: string) =>
          githubClassifier.classifyRequest(text),
        getTestStatus: async () => null
      },
      mcp: {
        execute: async () => ({ text: "unused" }),
        mcpClient: {
          listServers: () => []
        }
      }
    } as any,
    skillRegistry: {
      list: () => [],
      isEnabled: () => true,
      enable: () => ({
        changed: true,
        skills: []
      }),
      disable: () => ({
        changed: true,
        skills: []
      })
    } as any,
    scheduler: {
      triggerDailySummaryNow: async () => {}
    } as any,
    memoryStore: overrides.memoryStore as any,
    adminActions: overrides.restart ? { restart: overrides.restart } : {}
  });

  return { bot };
}

test("memory command stages a conversation-scoped record", async () => {
  const proposals: Array<Record<string, unknown>> = [];
  const { bot } = createDependencies({
    memoryStore: {
      isEnabled: () => true,
      list: () => [],
      propose: async (scope: Record<string, unknown>, content: string) => {
        proposals.push({ scope, content });
        return {
          duplicate: false,
          entry: {
            id: "memory-12345678",
            scope,
            content,
            status: "pending"
          }
        };
      }
    }
  });
  const ctx = createContext("/memory remember prefers concise replies");
  const handler = bot.commands.get("memory");

  if (!handler) throw new Error("Expected /memory handler to be registered");
  await handler(ctx);

  assert.deepEqual(proposals, [
    {
      scope: { ownerUserId: "1", conversationKey: "dm:1" },
      content: "prefers concise replies"
    }
  ]);
  assert.match(ctx.replies[0].text, /staged/i);
  assert.equal(ctx.replies[0].text.includes("memory\\-1"), true);
});

test("dev start reports the selected frontend script", async () => {
  const { bot } = createDependencies({
    devStart: async () => ({
      started: true,
      scriptName: "start",
      packageManager: "npm",
      command: "npm run start"
    })
  });
  const ctx = createContext("/dev start");
  const handler = bot.commands.get("dev");

  if (!handler) {
    throw new Error("Expected /dev handler to be registered");
  }

  await handler(ctx);

  assert.equal(ctx.replies.length > 0, true);
  assert.match(ctx.replies[0].text, /npm run start/i);
  assert.match(ctx.replies[0].text, /dev server|frontend/i);
});

test("sh git clone success suggests switching to the cloned repo", async () => {
  const { bot } = createDependencies({
    getStatus: () => ({
      backend: "sdk",
      active: false,
      activeMode: null,
      lastMode: null,
      lastExitCode: null,
      lastExitSignal: null,
      projectSessionId: null,
      preferredModel: null,
      language: "en",
      verboseOutput: false,
      ptySupported: null,
      workdir: "/workspace",
      relativeWorkdir: ".",
      workspaceRoot: "/workspace",
      command: "codex",
      mcpServers: [],
      workflowSystem: "superpowers",
      workflowPhase: "none"
    }),
    shellInspect: () => ({
      argv: ["git", "clone", "https://github.com/MackDing/opc-ren.git"],
      commandText: "git clone https://github.com/MackDing/opc-ren.git",
      confirmed: false,
      dangerous: false,
      requiresConfirmation: false,
      confirmationCommand: ""
    }),
    shellExecute: async () => ({
      started: true,
      status: "passed",
      command: "git clone https://github.com/MackDing/opc-ren.git",
      workdir: "/workspace",
      exitCode: 0,
      signal: null,
      output: "Cloning into 'opc-ren'..."
    })
  });
  const ctx = createContext(
    "/sh git clone https://github.com/MackDing/opc-ren.git"
  );
  const handler = bot.commands.get("sh");

  if (!handler) {
    throw new Error("Expected /sh handler to be registered");
  }

  await handler(ctx);

  assert.equal(ctx.replies.length, 3);
  assert.match(ctx.replies[2].text, /Clone completed/i);
  assert.match(ctx.replies[2].text, /opc\\-ren/i);
  assert.match(ctx.replies[2].text, /repo opc\\-ren/i);
});

test("dev status, url, and logs expose repo-scoped frontend runtime details", async () => {
  const { bot } = createDependencies({
    devStatus: () => ({
      running: true,
      status: "running",
      workdir: process.cwd(),
      startedByChatId: "1",
      command: "npm run dev",
      packageManager: "npm",
      scriptName: "dev",
      pid: 123,
      startedAt: "2026-03-15T04:00:00.000Z",
      exitedAt: null,
      exitCode: null,
      signal: null,
      detectedUrl: "http://127.0.0.1:5173/"
    }),
    devLogs: () => "Local: http://127.0.0.1:5173/",
    devUrl: () => "http://127.0.0.1:5173/"
  });
  const statusHandler = bot.commands.get("dev");

  if (!statusHandler) {
    throw new Error("Expected /dev handler to be registered");
  }

  const statusCtx = createContext("/dev status");
  await statusHandler(statusCtx);
  assert.equal(statusCtx.replies.length > 0, true);
  assert.match(statusCtx.replies[0].text, /running/i);
  assert.match(statusCtx.replies[0].text, /npm run dev/i);

  const urlCtx = createContext("/dev url");
  await statusHandler(urlCtx);
  assert.match(urlCtx.replies[0].text, /5173/);

  const logsCtx = createContext("/dev logs");
  await statusHandler(logsCtx);
  assert.match(logsCtx.replies[0].text, /Local:/);
});

test("status command includes the internal superpowers workflow phase", async () => {
  const { bot } = createDependencies({
    getStatus: () => ({
      backend: "sdk",
      active: false,
      activeMode: null,
      lastMode: "sdk",
      lastExitCode: 0,
      lastExitSignal: null,
      projectSessionId: "thread-123",
      preferredModel: null,
      language: "en",
      verboseOutput: true,
      ptySupported: null,
      workdir: process.cwd(),
      relativeWorkdir: ".",
      workspaceRoot: process.cwd(),
      command: "codex",
      mcpServers: [],
      workflowSystem: "superpowers",
      workflowPhase: "brainstorming"
    })
  });
  const ctx = createContext("/status");
  const handler = bot.commands.get("status");

  if (!handler) {
    throw new Error("Expected /status handler to be registered");
  }

  await handler(ctx);

  assert.equal(ctx.replies.length > 0, true);
  assert.match(ctx.replies[0].text, /workflow system: superpowers/i);
  assert.match(ctx.replies[0].text, /workflow phase: brainstorming/i);
});

test("skill list explains that superpowers is internal and not toggleable", async () => {
  const { bot } = createDependencies();
  const ctx = createContext("/skill");
  const handler = bot.commands.get("skill");

  if (!handler) {
    throw new Error("Expected /skill handler to be registered");
  }

  await handler(ctx);

  assert.equal(ctx.replies.length > 0, true);
  assert.match(ctx.replies[0].text, /internal workflow: superpowers/i);
  assert.match(ctx.replies[0].text, /not toggleable/i);
});

test("text handler warns before starting a second codex run in the same workdir", async () => {
  const { bot } = createDependencies({
    sendPrompt: async () => ({
      started: false,
      reason: "workspace_busy",
      activeMode: "sdk",
      blockingChatId: "2",
      relativeWorkdir: "."
    })
  });
  const ctx = createContext("please fix the repo");
  const textHandler = bot.events.get("text");

  if (!textHandler) {
    throw new Error("Expected text handler to be registered");
  }

  await textHandler(ctx);

  assert.equal(ctx.replies.length > 0, true);
  assert.match(ctx.replies[0].text, /\/continue/);
  assert.match(ctx.replies[0].text, /same workdir|same project|another chat/i);
});

test("continue command replays a blocked request once", async () => {
  const { bot } = createDependencies({
    continuePendingPrompt: async () => ({
      started: true,
      mode: "sdk"
    })
  });
  const ctx = createContext("/continue");
  const handler = bot.commands.get("continue");

  if (!handler) {
    throw new Error("Expected /continue handler to be registered");
  }

  await handler(ctx);

  assert.equal(ctx.replies.length > 0, true);
  assert.match(ctx.replies[0].text, /continu|replay/i);
});

test("continue command reports when no blocked request is pending", async () => {
  const { bot } = createDependencies({
    continuePendingPrompt: async () => ({
      started: false,
      reason: "no_pending_prompt"
    })
  });
  const ctx = createContext("/continue");
  const handler = bot.commands.get("continue");

  if (!handler) {
    throw new Error("Expected /continue handler to be registered");
  }

  await handler(ctx);

  assert.equal(ctx.replies.length > 0, true);
  assert.match(ctx.replies[0].text, /no blocked|nothing pending/i);
});

test("text handler shows guidance when plain-text github write actions are blocked", async () => {
  const switched: Array<{ chatId: string | number; target: string }> = [];
  const { bot } = createDependencies({
    routeMessage: async (text: string) => ({
      target: "skill" as const,
      skill: "github" as const,
      payload: text
    }),
    githubExecute: async () => ({
      text: "GitHub write actions require explicit /gh commands. Use /gh create repo five-in-a-row."
    }),
    switchWorkdir: (chatId, target) => {
      switched.push({ chatId, target });
      return {
        workdir: `/tmp/${target}`,
        relativePath: target
      };
    }
  });
  const ctx = createContext("create repo five-in-a-row");
  const textHandler = bot.events.get("text");

  if (!textHandler) {
    throw new Error("Expected text handler to be registered");
  }

  await textHandler(ctx);

  assert.deepEqual(switched, []);
  assert.equal(ctx.replies.length > 0, true);
  assert.match(ctx.replies[0].text, /explicit/i);
  assert.match(ctx.replies[0].text, /\/gh create repo/i);
});

function commandHandler(
  bot: FakeBot,
  name: string
): (ctx: TestContext) => Promise<void> | void {
  const handler = bot.commands.get(name);
  if (!handler) {
    throw new Error(`Expected /${name} handler to be registered`);
  }
  return handler;
}

test("commands without the required capability are refused before running", async () => {
  let restarted = false;
  const { bot } = createDependencies({
    restart: async () => {
      restarted = true;
    }
  });
  const ctx = createContext("/restart", 1, grantWithout("bot.restart"));

  await commandHandler(bot, "restart")(ctx);

  assert.equal(restarted, false);
  assert.equal(ctx.replies.length, 1);
  assert.match(ctx.replies[0].text, /bot\.restart/);
  assert.match(ctx.replies[0].text, /viewer/);
});

test("silent deny feedback refuses without replying", async () => {
  let restarted = false;
  const { bot } = createDependencies({
    restart: async () => {
      restarted = true;
    }
  });
  const ctx = createContext("/restart", 1, {
    ...grantWithout("bot.restart"),
    denyFeedback: "silent"
  });

  await commandHandler(bot, "restart")(ctx);

  assert.equal(restarted, false);
  assert.equal(ctx.replies.length, 0);
});

test("a context without a resolved grant fails closed", async () => {
  let restarted = false;
  const { bot } = createDependencies({
    restart: async () => {
      restarted = true;
    }
  });
  const ctx = createContext("/restart");
  delete ctx.state.codexSmith.grant;

  await commandHandler(bot, "restart")(ctx);

  assert.equal(restarted, false);
});

test("plain-text test runs routed to GitHub require gh.test", async () => {
  let executed = false;
  const { bot } = createDependencies({
    routeMessage: async (text: string) => ({
      target: "skill" as const,
      skill: "github" as const,
      payload: text
    }),
    githubExecute: async () => {
      executed = true;
      return { text: "started" };
    }
  });
  const ctx = createContext("run tests please", 1, grantWithout("gh.test"));
  const textHandler = bot.events.get("text");
  if (!textHandler) throw new Error("Expected text handler");

  await textHandler(ctx);

  assert.equal(executed, false);
  assert.match(ctx.replies[0].text, /gh\.test/);
});

test("prompts are refused when the current repository is outside the user scope", async () => {
  let prompted = false;
  const { bot } = createDependencies({
    sendPrompt: async () => {
      prompted = true;
      return { started: true, mode: "sdk" };
    }
  });
  const ctx = createContext(
    "explain this repo",
    1,
    createGrant({ userRepos: ["some-other-project"] })
  );
  const textHandler = bot.events.get("text");
  if (!textHandler) throw new Error("Expected text handler");

  await textHandler(ctx);

  assert.equal(prompted, false);
  assert.match(ctx.replies[0].text, /outside your access scope/);
});

test("repo list only shows repositories inside the user scope", async () => {
  const root = process.cwd();
  const { bot } = createDependencies({
    listProjects: () => [
      { name: "alpha", path: `${root}/alpha`, relativePath: "alpha" },
      { name: "beta", path: `${root}/beta`, relativePath: "beta" }
    ]
  });
  const ctx = createContext("/repo", 1, createGrant({ userRepos: ["alpha"] }));

  await commandHandler(bot, "repo")(ctx);

  const text = ctx.replies.map((reply) => reply.text).join("\n");
  assert.match(text, /alpha/);
  assert.doesNotMatch(text, /beta/);
});

test("continue requires codex.auto when the blocked request was /auto", async () => {
  let continued = false;
  const { bot } = createDependencies({
    peekPendingPrompt: () => ({ workdir: process.cwd(), fullAuto: true }),
    continuePendingPrompt: async () => {
      continued = true;
      return { started: true, mode: "sdk" };
    }
  });
  const ctx = createContext("/continue", 1, grantWithout("codex.auto"));

  await commandHandler(bot, "continue")(ctx);

  assert.equal(continued, false);
  assert.match(ctx.replies[0].text, /codex\.auto/);
});

test("model command rejects names with unexpected characters", async () => {
  const { bot } = createDependencies();
  const ctx = createContext("/model gpt-5 --oss");

  await commandHandler(bot, "model")(ctx);

  assert.match(ctx.replies[0].text, /Model names/);
});

test("whoami lists the role, scopes and granted commands", async () => {
  const { bot } = createDependencies();
  const ctx = createContext(
    "/whoami",
    1,
    createGrant({
      role: "developer",
      roleLabel: "developer (capped by viewer)",
      capabilities: ["bot.status", "codex.prompt"],
      userRepos: ["alpha"],
      codex: { sandbox: "read-only" }
    })
  );

  await commandHandler(bot, "whoami")(ctx);

  const text = ctx.replies.map((reply) => reply.text).join("\n");
  assert.match(text, /capped by viewer/);
  assert.match(text, /user\\=alpha/);
  assert.match(text, /sandbox\\=read\\-only/);
  assert.match(text, /codex\\\.prompt/);
  assert.doesNotMatch(text, /gh\\\.write/);
});
