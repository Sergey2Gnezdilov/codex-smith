import type { Context, MiddlewareFn } from "telegraf";
import type { AppConfig } from "../config.js";
import {
  AccessPolicyStore,
  buildLegacyAccessPolicy,
  resolveAccessGrant,
  resolveChatAccess,
  type AccessPolicySource
} from "../access/policy.js";
import {
  runWithAccessState,
  type CodexSmithAccessState
} from "./accessContext.js";

type AccessContext = Context & {
  state: Context["state"] & {
    codexSmith?: CodexSmithAccessState;
  };
};

function getSenderId(ctx: Context): string {
  return String(ctx.callbackQuery?.from?.id || ctx.from?.id || "");
}

function getCommand(text: string): string | null {
  const match = text.match(/^\/([a-z0-9_]+)(?:@[a-z0-9_]+)?(?:\s|$)/i);
  return match?.[1]?.toLowerCase() || null;
}

function isDirectedAtBot(ctx: Context): boolean {
  if (ctx.callbackQuery) return true;

  const message = ctx.message;
  if (!message || !("text" in message)) return false;
  const text = String(message.text || "");
  if (getCommand(text)) return true;

  const botId = ctx.botInfo?.id;
  const reply = "reply_to_message" in message ? message.reply_to_message : null;
  if (reply?.from?.id && botId && reply.from.id === botId) return true;

  const username = String(ctx.me || "").trim();
  return Boolean(
    username && text.toLowerCase().includes(`@${username.toLowerCase()}`)
  );
}

export function getConversationKey(ctx: Context): string {
  const access = (ctx as AccessContext).state?.codexSmith;
  return access?.conversationKey || String(ctx.chat?.id || "");
}

function isPolicySource(value: unknown): value is AccessPolicySource {
  return Boolean(
    value && typeof (value as AccessPolicySource).get === "function"
  );
}

export function createAuthMiddleware(
  source: AccessPolicySource | Pick<AppConfig, "telegram">
): MiddlewareFn<Context> {
  const policies: AccessPolicySource = isPolicySource(source)
    ? source
    : new AccessPolicyStore(() => buildLegacyAccessPolicy(source.telegram));
  const reportedChats = new Set<string>();

  return async (ctx, next) => {
    const userId = getSenderId(ctx);
    const chatId = String(ctx.chat?.id || "");
    if (!userId || !chatId) {
      return;
    }

    const policy = policies.get();
    const chat = resolveChatAccess(policy, chatId, ctx.chat?.type);
    if (!chat) {
      if (policy.settings.audit !== "off" && !reportedChats.has(chatId)) {
        reportedChats.add(chatId);
        console.info(
          `[access] ignoring chat ${chatId} (${ctx.chat?.type || "unknown"}): not listed in the access policy`
        );
      }
      return;
    }

    if (chat.kind === "group" && chat.requireMention && !isDirectedAtBot(ctx)) {
      return;
    }

    const result = resolveAccessGrant(policy, chat, userId);
    if (!result.allowed) {
      if (policy.settings.audit !== "off") {
        console.info(
          `[access] deny user=${userId} chat=${chatId} reason=${result.reason}`
        );
      }
      return;
    }

    const conversationKey =
      chat.kind === "group"
        ? chat.conversation === "shared"
          ? `group:${chatId}`
          : `group:${chatId}:user:${userId}`
        : `dm:${userId}`;

    const accessCtx = ctx as AccessContext;
    const accessState: CodexSmithAccessState = {
      userId,
      chatId,
      conversationKey,
      isAdmin: result.grant.capabilities.includes("access.manage"),
      grant: result.grant
    };
    accessCtx.state.codexSmith = accessState;

    await runWithAccessState(accessState, next);
  };
}
