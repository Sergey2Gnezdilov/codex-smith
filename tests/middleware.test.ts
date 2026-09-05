import test from "node:test";
import assert from "node:assert/strict";
import type { Context } from "telegraf";
import {
  createAuthMiddleware,
  getConversationKey
} from "../src/bot/middleware.js";
import { resolveConversationKey } from "../src/bot/accessContext.js";

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

async function passes(ctx: Context, config = createConfig()): Promise<boolean> {
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

test("non-admin users cannot invoke protected commands", async () => {
  const config = createConfig({
    allowedUserIds: ["123", "456"],
    adminUserIds: ["123"]
  });
  assert.equal(
    await passes(createContext({ fromId: 456, text: "/restart" }), config),
    false
  );
  assert.equal(
    await passes(createContext({ fromId: 456, text: "/status" }), config),
    true
  );
});

test("auth middleware also checks callback query origin", async () => {
  assert.equal(
    await passes(createContext({ callbackFromId: 123, chatId: 123 })),
    true
  );
});
