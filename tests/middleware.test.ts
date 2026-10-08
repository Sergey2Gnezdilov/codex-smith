import test from "node:test";
import assert from "node:assert/strict";
import type { Context } from "telegraf";
import {
  createAuthMiddleware,
  getConversationKey
} from "../src/bot/middleware.js";
import {
  resolveConversationKey,
  type CodexSmithAccessState
} from "../src/bot/accessContext.js";
import {
  AccessPolicyStore,
  parseAccessPolicy,
  type AccessGrant,
  type AccessPolicySource
} from "../src/access/policy.js";

function createConfig({
  allowedUserIds = ["123"],
  groupAllowedUserIds = [] as string[],
  adminUserIds = ["123"],
  groupConversationScope = "per-user" as "per-user" | "shared",
  groupRequireMention = true
} = {}) {
  return {
    telegram: {
      botToken: "dummy-token",
      apiBase: "https://api.telegram.org",
      proxyUrl: undefined,
      allowedUserIds,
      groupAllowedUserIds,
      adminUserIds,
      adminOnlyCommands: ["restart", "sh"],
      groupConversationScope,
      groupRequireMention,
      proactiveUserIds: []
    }
  };
}

function createContext({
  fromId,
  callbackFromId,
  chatId = 123,
  chatType = "private",
  text
}: {
  fromId?: number;
  callbackFromId?: number;
  chatId?: number;
  chatType?: "private" | "group" | "supergroup";
  text?: string;
}): Context {
  const from =
    fromId === undefined
      ? undefined
      : {
          id: fromId,
          is_bot: false,
          first_name: "Test User"
        };

  return {
    state: {},
    from,
    chat: {
      id: chatId,
      type: chatType,
      ...(chatType === "private"
        ? { first_name: "Test User" }
        : { title: "Test Group" })
    },
    message:
      text === undefined
        ? undefined
        : ({
            message_id: 1,
            date: 1,
            chat: { id: chatId, type: chatType },
            from,
            text
          } as Context["message"]),
    callbackQuery:
      callbackFromId === undefined
        ? undefined
        : ({
            id: "callback",
            chat_instance: "instance",
            from: {
              id: callbackFromId,
              is_bot: false,
              first_name: "Callback User"
            },
            message: {
              message_id: 1,
              date: 1,
              chat: { id: chatId, type: chatType }
            }
          } as Context["callbackQuery"])
  } as Context;
}

function policySource(raw: unknown): AccessPolicySource {
  return new AccessPolicyStore(() =>
    parseAccessPolicy(raw, {
      source: "test",
      groupDefaults: { conversation: "per-user", requireMention: true }
    })
  );
}

function grantOf(ctx: Context): AccessGrant {
  const grant = (ctx.state as { codexSmith?: CodexSmithAccessState }).codexSmith
    ?.grant;
  if (!grant) throw new Error("Expected a resolved grant");
  return grant;
}

async function passes(
  ctx: Context,
  config: AccessPolicySource | ReturnType<typeof createConfig> = createConfig()
): Promise<boolean> {
  const middleware = createAuthMiddleware(config);
  let called = false;
  await middleware(ctx, async () => {
    called = true;
  });
  return called;
}

test("auth middleware allows whitelisted users in private chats", async () => {
  const ctx = createContext({ fromId: 123 });
  assert.equal(await passes(ctx), true);
  assert.equal(getConversationKey(ctx), "dm:123");
});

test("auth middleware silently blocks non-whitelisted users", async () => {
  assert.equal(await passes(createContext({ fromId: 999 })), false);
});

test("group-only users cannot open private conversations", async () => {
  const config = createConfig({
    allowedUserIds: ["123"],
    groupAllowedUserIds: ["456"]
  });
  assert.equal(await passes(createContext({ fromId: 456 }), config), false);
});

test("group conversations are isolated by user by default", async () => {
  const config = createConfig({ groupAllowedUserIds: ["456"] });
  const ctx = createContext({
    fromId: 456,
    chatId: -1001,
    chatType: "supergroup",
    text: "/status"
  });

  assert.equal(await passes(ctx, config), true);
  assert.equal(getConversationKey(ctx), "group:-1001:user:456");
});

test("conversation identity propagates through async handler work", async () => {
  const middleware = createAuthMiddleware(
    createConfig({ groupAllowedUserIds: ["456"] })
  );
  const ctx = createContext({
    fromId: 456,
    chatId: -1001,
    chatType: "supergroup",
    text: "/status"
  });
  let observed = "";

  await middleware(ctx, async () => {
    await Promise.resolve();
    observed = resolveConversationKey(-1001);
  });

  assert.equal(observed, "group:-1001:user:456");
  assert.equal(resolveConversationKey(-1001), "-1001");
});

test("shared group scope is explicit", async () => {
  const config = createConfig({
    groupAllowedUserIds: ["456"],
    groupConversationScope: "shared"
  });
  const ctx = createContext({
    fromId: 456,
    chatId: -1001,
    chatType: "group",
    text: "/status"
  });

  assert.equal(await passes(ctx, config), true);
  assert.equal(getConversationKey(ctx), "group:-1001");
});

test("untargeted group chatter is ignored", async () => {
  const ctx = createContext({
    fromId: 123,
    chatId: -1001,
    chatType: "group",
    text: "hello everyone"
  });
  assert.equal(await passes(ctx), false);
});

test("legacy admin-only commands become missing capabilities for non-admins", async () => {
  const config = createConfig({
    allowedUserIds: ["123", "456"],
    adminUserIds: ["123"]
  });
  const member = createContext({ fromId: 456, text: "/restart" });
  const admin = createContext({ fromId: 123, text: "/restart" });

  assert.equal(await passes(member, config), true);
  assert.equal(await passes(admin, config), true);

  const memberGrant = grantOf(member);
  assert.equal(memberGrant.capabilities.includes("bot.restart"), false);
  assert.equal(memberGrant.capabilities.includes("shell.run"), false);
  assert.equal(memberGrant.capabilities.includes("access.manage"), false);
  assert.equal(memberGrant.capabilities.includes("codex.prompt"), true);
  assert.equal(grantOf(admin).capabilities.includes("bot.restart"), true);
});

test("policy file mode ignores groups that are not listed", async () => {
  const source = policySource({
    users: { "123": "admin" }
  });
  const ctx = createContext({
    fromId: 123,
    chatId: -1009,
    chatType: "supergroup",
    text: "/status"
  });

  assert.equal(await passes(ctx, source), false);
});

test("group default role admits unlisted members and maxRole caps listed ones", async () => {
  const source = policySource({
    users: { "123": "admin" },
    groups: {
      "-1001": { maxRole: "developer", defaultRole: "viewer" }
    }
  });
  const stranger = createContext({
    fromId: 777,
    chatId: -1001,
    chatType: "supergroup",
    text: "/status"
  });
  const admin = createContext({
    fromId: 123,
    chatId: -1001,
    chatType: "supergroup",
    text: "/status"
  });

  assert.equal(await passes(stranger, source), true);
  assert.equal(grantOf(stranger).role, "viewer");
  assert.equal(grantOf(stranger).codex.sandbox, "read-only");

  assert.equal(await passes(admin, source), true);
  assert.equal(grantOf(admin).roleLabel, "admin (capped by developer)");
  assert.equal(grantOf(admin).capabilities.includes("bot.restart"), false);
  assert.equal(grantOf(admin).capabilities.includes("codex.exec"), true);
  assert.equal(grantOf(admin).codex.sandbox, "workspace-write");
});

test("users can be restricted to group chats", async () => {
  const source = policySource({
    users: { "456": { role: "developer", privateChat: false } },
    groups: { "-1001": {} }
  });

  assert.equal(await passes(createContext({ fromId: 456 }), source), false);
  assert.equal(
    await passes(
      createContext({
        fromId: 456,
        chatId: -1001,
        chatType: "group",
        text: "/status"
      }),
      source
    ),
    true
  );
});

test("auth middleware also checks callback query origin", async () => {
  assert.equal(
    await passes(createContext({ callbackFromId: 123, chatId: 123 })),
    true
  );
});
