import type { Context, MiddlewareFn } from "telegraf";
import type { AppConfig } from "../config.js";
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

function isGroupChat(ctx: Context): boolean {
  return ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
}

function isPrivateChat(ctx: Context): boolean {
  return ctx.chat?.type === "private";
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

export function createAuthMiddleware(
  config: Pick<AppConfig, "telegram">
): MiddlewareFn<Context> {
  const allowedSet = new Set(config.telegram.allowedUserIds.map(String));
  const groupAllowedSet = new Set(
    config.telegram.groupAllowedUserIds.map(String)
  );
  const adminSet = new Set(config.telegram.adminUserIds.map(String));
  const adminOnlyCommands = new Set(config.telegram.adminOnlyCommands);

  return async (ctx, next) => {
    const userId = getSenderId(ctx);
    const chatId = String(ctx.chat?.id || "");
    if (!userId || !chatId) {
      return;
    }

    const group = isGroupChat(ctx);
    const privateChat = isPrivateChat(ctx);
    const allowed = privateChat
      ? allowedSet.has(userId)
      : group && (allowedSet.has(userId) || groupAllowedSet.has(userId));
    if (!allowed) return;

    if (group && config.telegram.groupRequireMention && !isDirectedAtBot(ctx)) {
      return;
    }

    const message = ctx.message;
    const text = message && "text" in message ? String(message.text || "") : "";
    const command = getCommand(text);
    const isAdmin = adminSet.has(userId);
    if (command && adminOnlyCommands.has(command) && !isAdmin) return;

    const conversationKey = group
      ? config.telegram.groupConversationScope === "shared"
        ? `group:${chatId}`
        : `group:${chatId}:user:${userId}`
      : `dm:${userId}`;

    const accessCtx = ctx as AccessContext;
    const accessState: CodexSmithAccessState = {
      userId,
      chatId,
      conversationKey,
      isAdmin
    };
    accessCtx.state.codexSmith = accessState;

    await runWithAccessState(accessState, next);
  };
}
