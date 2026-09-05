import { AsyncLocalStorage } from "node:async_hooks";

export interface CodexSmithAccessState {
  userId: string;
  chatId: string;
  conversationKey: string;
  isAdmin: boolean;
}

const accessStorage = new AsyncLocalStorage<CodexSmithAccessState>();

export async function runWithAccessState<T>(
  state: CodexSmithAccessState,
  callback: () => Promise<T>
): Promise<T> {
  return accessStorage.run(state, callback);
}

export function resolveConversationKey(chatId: string | number): string {
  const raw = String(chatId);
  const access = accessStorage.getStore();
  return access?.chatId === raw ? access.conversationKey : raw;
}

export function getCurrentAccessState(): CodexSmithAccessState | undefined {
  return accessStorage.getStore();
}

export function getLegacyConversationKey(
  conversationKey: string
): string | null {
  const direct = conversationKey.match(/^dm:(.+)$/);
  if (direct?.[1]) return direct[1];

  const sharedGroup = conversationKey.match(/^group:([^:]+)$/);
  return sharedGroup?.[1] || null;
}
