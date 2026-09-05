import {
  getLegacyConversationKey,
  resolveConversationKey
} from "../bot/accessContext.js";

export interface SkillStatus {
  name: string;
  enabled: boolean;
}

export interface SkillRegistrySnapshot {
  chats: Record<
    string,
    {
      enabledSkills: string[];
    }
  >;
}

interface ChatSkillState {
  enabledSkills: Set<string>;
}

export interface SkillRegistryOptions {
  onChange?: (snapshot: SkillRegistrySnapshot) => void;
}

export class SkillRegistry {
  private readonly skillNames: string[];
  private readonly chatStates: Map<string, ChatSkillState>;
  private readonly onChange?: SkillRegistryOptions["onChange"];

  constructor(
    skills: Record<string, unknown> = {},
    { onChange }: SkillRegistryOptions = {}
  ) {
    this.skillNames = Object.keys(skills).sort();
    this.chatStates = new Map();
    this.onChange = onChange;
  }

  normalizeSkillName(name: string | undefined | null): string {
    return String(name || "")
      .trim()
      .toLowerCase();
  }

  ensureKnownSkill(name: string | undefined | null): string {
    const normalized = this.normalizeSkillName(name);
    if (!this.skillNames.includes(normalized)) {
      throw new Error(`Unknown skill: ${name}`);
    }
    return normalized;
  }

  ensureChatState(chatId: string | number): ChatSkillState {
    const key = resolveConversationKey(chatId);
    const existing = this.chatStates.get(key);
    if (existing) return existing;

    const legacyKey = getLegacyConversationKey(key);
    const legacy = legacyKey ? this.chatStates.get(legacyKey) : undefined;
    if (legacy && legacyKey) {
      this.chatStates.delete(legacyKey);
      this.chatStates.set(key, legacy);
      this.onChange?.(this.exportState());
      return legacy;
    }

    const state: ChatSkillState = {
      enabledSkills: new Set(this.skillNames)
    };

    this.chatStates.set(key, state);
    return state;
  }

  list(chatId: string | number): SkillStatus[] {
    const state = this.ensureChatState(chatId);
    return this.skillNames.map((name) => ({
      name,
      enabled: state.enabledSkills.has(name)
    }));
  }

  isEnabled(chatId: string | number, name: string): boolean {
    const normalized = this.ensureKnownSkill(name);
    const state = this.ensureChatState(chatId);
    return state.enabledSkills.has(normalized);
  }

  enable(
    chatId: string | number,
    name: string
  ): { changed: boolean; skills: SkillStatus[] } {
    const normalized = this.ensureKnownSkill(name);
    const state = this.ensureChatState(chatId);
    const changed = !state.enabledSkills.has(normalized);
    state.enabledSkills.add(normalized);
    if (changed) {
      this.onChange?.(this.exportState());
    }
    return {
      changed,
      skills: this.list(chatId)
    };
  }

  disable(
    chatId: string | number,
    name: string
  ): { changed: boolean; skills: SkillStatus[] } {
    const normalized = this.ensureKnownSkill(name);
    const state = this.ensureChatState(chatId);
    const changed = state.enabledSkills.has(normalized);
    state.enabledSkills.delete(normalized);
    if (changed) {
      this.onChange?.(this.exportState());
    }
    return {
      changed,
      skills: this.list(chatId)
    };
  }

  exportState(): SkillRegistrySnapshot {
    const chats: SkillRegistrySnapshot["chats"] = {};
    for (const [chatId, state] of this.chatStates.entries()) {
      chats[chatId] = {
        enabledSkills: [...state.enabledSkills].sort()
      };
    }

    return {
      chats
    };
  }

  restoreState(snapshot: SkillRegistrySnapshot | undefined = undefined): void {
    const chats = snapshot?.chats;
    if (!chats || typeof chats !== "object") return;

    this.chatStates.clear();

    for (const [chatId, state] of Object.entries(chats)) {
      const enabledSkills = Array.isArray(state?.enabledSkills)
        ? state.enabledSkills
            .map((skill) => this.normalizeSkillName(skill))
            .filter((skill) => this.skillNames.includes(skill))
        : this.skillNames;

      this.chatStates.set(String(chatId), {
        enabledSkills: new Set(enabledSkills)
      });
    }
  }
}
