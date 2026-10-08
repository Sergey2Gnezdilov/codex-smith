import fs from "node:fs";
import type {
  AppConfig,
  CodexApprovalPolicy,
  CodexSandboxMode,
  GroupConversationScope
} from "../config.js";
import { toErrorMessage } from "../lib/errors.js";
import {
  CAPABILITIES,
  LEGACY_COMMAND_CAPABILITIES,
  isValidCapabilityPattern,
  matchesCapabilityPattern,
  type Capability
} from "./capabilities.js";

export type DenyFeedback = "notice" | "silent";
export type AuditLevel = "off" | "denied" | "all";
export type UnknownGroupMode = "deny" | "allow";
export type ChatKind = "private" | "group";

export interface RoleCodexSettings {
  sandbox?: CodexSandboxMode;
  approval?: CodexApprovalPolicy;
  network?: boolean;
}

export interface AccessRole {
  name: string;
  description: string;
  allow: string[];
  deny: string[];
  codex: RoleCodexSettings;
}

export interface AccessUser {
  role: string;
  repos: string[];
  privateChat: boolean;
}

export interface AccessGroup {
  maxRole: string | null;
  defaultRole: string | null;
  repos: string[];
  conversation: GroupConversationScope;
  requireMention: boolean;
}

export interface GroupDefaults {
  conversation: GroupConversationScope;
  requireMention: boolean;
}

export interface AccessSettings {
  deny: {
    privateChats: DenyFeedback;
    groups: DenyFeedback;
    cooldownSeconds: number;
  };
  audit: AuditLevel;
  unknownGroups: UnknownGroupMode;
  groupDefaults: GroupDefaults;
}

export interface AccessPolicy {
  source: string;
  settings: AccessSettings;
  roles: Map<string, AccessRole>;
  users: Map<string, AccessUser>;
  groups: Map<string, AccessGroup>;
}

export interface ChatAccess {
  chatId: string;
  kind: ChatKind;
  group: AccessGroup | null;
  conversation: GroupConversationScope;
  requireMention: boolean;
}

export interface AccessGrant {
  userId: string;
  chatId: string;
  kind: ChatKind;
  role: string;
  roleLabel: string;
  capabilities: Capability[];
  userRepos: string[];
  chatRepos: string[];
  codex: RoleCodexSettings;
  denyFeedback: DenyFeedback;
  audit: AuditLevel;
  cooldownSeconds: number;
}

export type AccessDenialReason =
  "unknown_user" | "private_chat_disabled" | "unknown_role";

export type GrantResult =
  | { allowed: true; grant: AccessGrant }
  | { allowed: false; reason: AccessDenialReason };

interface RawRole {
  inherits?: string;
  description?: string;
  capabilities: string[];
  codex?: RoleCodexSettings;
}

const SANDBOX_MODES: readonly CodexSandboxMode[] = [
  "read-only",
  "workspace-write",
  "danger-full-access"
];
// Ordered from the most to the least restrictive.
const APPROVAL_POLICIES: readonly CodexApprovalPolicy[] = [
  "untrusted",
  "on-request",
  "on-failure",
  "never"
];
const CONVERSATION_SCOPES: readonly GroupConversationScope[] = [
  "per-user",
  "shared"
];
const DENY_FEEDBACK: readonly DenyFeedback[] = ["notice", "silent"];
const AUDIT_LEVELS: readonly AuditLevel[] = ["off", "denied", "all"];
const UNKNOWN_GROUP_MODES: readonly UnknownGroupMode[] = ["deny", "allow"];

export const BUILT_IN_ROLES: Readonly<Record<string, RawRole>> = {
  viewer: {
    description: "Asks Codex about code in a read-only sandbox",
    capabilities: [
      "bot.status",
      "bot.preferences",
      "repo.list",
      "repo.switch",
      "codex.prompt",
      "codex.plan",
      "memory.use"
    ],
    codex: { sandbox: "read-only" }
  },
  developer: {
    inherits: "viewer",
    description: "Lets Codex change files in allowed repositories",
    capabilities: [
      "codex.exec",
      "codex.model",
      "gh.read",
      "dev.read",
      "mcp.read"
    ],
    codex: { sandbox: "workspace-write" }
  },
  operator: {
    inherits: "developer",
    description: "Runs dev servers, tests, the restricted shell and MCP tools",
    capabilities: ["dev.run", "shell.run", "gh.test", "mcp.call"]
  },
  admin: {
    inherits: "operator",
    description: "Full control, including GitHub writes and bot management",
    capabilities: ["*"]
  }
};

function fail(where: string, message: string): never {
  throw new Error(`Invalid access policy at ${where}: ${message}`);
}

function asObject(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(where, "expected an object");
  }
  return value as Record<string, unknown>;
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string
): void {
  for (const key of Object.keys(value)) {
    if (key.startsWith("_")) continue;
    if (!allowed.includes(key)) {
      fail(where, `unknown key "${key}"`);
    }
  }
}

function readEnum<T extends string>(
  value: unknown,
  supported: readonly T[],
  where: string
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !supported.includes(value as T)) {
    fail(where, `expected one of ${supported.join(", ")}`);
  }
  return value as T;
}

function readBoolean(value: unknown, where: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") fail(where, "expected true or false");
  return value;
}

function readString(value: unknown, where: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    fail(where, "expected a non-empty string");
  }
  return value.trim();
}

function readStringList(value: unknown, where: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(where, "expected a list of strings");
  }
  return (value as string[]).map((item) => item.trim()).filter(Boolean);
}

export function normalizeRepoEntry(entry: string, where: string): string {
  const normalized = entry
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
  if (normalized === "*" || normalized === "." || normalized === "") {
    return "*";
  }
  if (
    normalized.startsWith("/") ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    fail(where, `repository "${entry}" must be relative to WORKSPACE_ROOT`);
  }
  return normalized;
}

function readRepos(value: unknown, where: string): string[] {
  const list = readStringList(value, where);
  if (!list) return ["*"];
  return [...new Set(list.map((entry) => normalizeRepoEntry(entry, where)))];
}

function readCodexSettings(value: unknown, where: string): RoleCodexSettings {
  if (value === undefined) return {};
  const raw = asObject(value, where);
  assertKnownKeys(raw, ["sandbox", "approval", "network"], where);
  const settings: RoleCodexSettings = {};
  const sandbox = readEnum(raw.sandbox, SANDBOX_MODES, `${where}.sandbox`);
  const approval = readEnum(
    raw.approval,
    APPROVAL_POLICIES,
    `${where}.approval`
  );
  const network = readBoolean(raw.network, `${where}.network`);
  if (sandbox) settings.sandbox = sandbox;
  if (approval) settings.approval = approval;
  if (network !== undefined) settings.network = network;
  return settings;
}

function readRawRole(value: unknown, where: string): RawRole {
  const raw = asObject(value, where);
  assertKnownKeys(
    raw,
    ["inherits", "description", "capabilities", "codex"],
    where
  );
  const capabilities =
    readStringList(raw.capabilities, `${where}.capabilities`) || [];
  for (const pattern of capabilities) {
    if (!isValidCapabilityPattern(pattern)) {
      fail(`${where}.capabilities`, `unknown capability "${pattern}"`);
    }
  }
  return {
    inherits: readString(raw.inherits, `${where}.inherits`),
    description: readString(raw.description, `${where}.description`),
    capabilities,
    codex: readCodexSettings(raw.codex, `${where}.codex`)
  };
}

export function resolveRoles(
  rawRoles: Record<string, RawRole>
): Map<string, AccessRole> {
  const resolved = new Map<string, AccessRole>();

  const resolve = (name: string, chain: string[]): AccessRole => {
    const existing = resolved.get(name);
    if (existing) return existing;
    if (chain.includes(name)) {
      fail(
        `roles.${name}`,
        `inheritance cycle ${[...chain, name].join(" -> ")}`
      );
    }
    const raw = rawRoles[name];
    if (!raw) fail(`roles.${chain.at(-1) || name}`, `unknown role "${name}"`);

    const parent = raw.inherits
      ? resolve(raw.inherits, [...chain, name])
      : null;
    const own = raw.capabilities;
    const role: AccessRole = {
      name,
      description: raw.description || parent?.description || "",
      allow: [
        ...(parent?.allow || []),
        ...own.filter((pattern) => !pattern.startsWith("!"))
      ],
      deny: [
        ...(parent?.deny || []),
        ...own
          .filter((pattern) => pattern.startsWith("!"))
          .map((pattern) => pattern.slice(1))
      ],
      codex: { ...(parent?.codex || {}), ...(raw.codex || {}) }
    };
    resolved.set(name, role);
    return role;
  };

  for (const name of Object.keys(rawRoles)) {
    resolve(name, []);
  }
  return resolved;
}

export function roleAllows(role: AccessRole, capability: Capability): boolean {
  return (
    role.allow.some((pattern) =>
      matchesCapabilityPattern(pattern, capability)
    ) &&
    !role.deny.some((pattern) => matchesCapabilityPattern(pattern, capability))
  );
}

function requireRole(
  roles: Map<string, AccessRole>,
  name: string | null,
  where: string
): void {
  if (name && !roles.has(name)) fail(where, `unknown role "${name}"`);
}

export function parseAccessPolicy(
  input: unknown,
  { source, groupDefaults }: { source: string; groupDefaults: GroupDefaults }
): AccessPolicy {
  const raw = asObject(input, "root");
  assertKnownKeys(
    raw,
    ["version", "settings", "roles", "users", "groups"],
    "root"
  );
  if (raw.version !== undefined && raw.version !== 1) {
    fail("version", "only version 1 is supported");
  }

  const rawSettings =
    raw.settings === undefined ? {} : asObject(raw.settings, "settings");
  assertKnownKeys(
    rawSettings,
    ["deny", "audit", "unknownGroups", "groupDefaults"],
    "settings"
  );
  const rawDeny =
    rawSettings.deny === undefined
      ? {}
      : asObject(rawSettings.deny, "settings.deny");
  assertKnownKeys(
    rawDeny,
    ["privateChats", "groups", "cooldownSeconds"],
    "settings.deny"
  );
  const cooldown = rawDeny.cooldownSeconds;
  if (
    cooldown !== undefined &&
    (typeof cooldown !== "number" || !Number.isFinite(cooldown) || cooldown < 0)
  ) {
    fail("settings.deny.cooldownSeconds", "expected a non-negative number");
  }
  const rawGroupDefaults =
    rawSettings.groupDefaults === undefined
      ? {}
      : asObject(rawSettings.groupDefaults, "settings.groupDefaults");
  assertKnownKeys(
    rawGroupDefaults,
    ["conversation", "requireMention"],
    "settings.groupDefaults"
  );

  const settings: AccessSettings = {
    deny: {
      privateChats:
        readEnum(
          rawDeny.privateChats,
          DENY_FEEDBACK,
          "settings.deny.privateChats"
        ) || "notice",
      groups:
        readEnum(rawDeny.groups, DENY_FEEDBACK, "settings.deny.groups") ||
        "silent",
      cooldownSeconds: typeof cooldown === "number" ? cooldown : 60
    },
    audit:
      readEnum(rawSettings.audit, AUDIT_LEVELS, "settings.audit") || "denied",
    unknownGroups:
      readEnum(
        rawSettings.unknownGroups,
        UNKNOWN_GROUP_MODES,
        "settings.unknownGroups"
      ) || "deny",
    groupDefaults: {
      conversation:
        readEnum(
          rawGroupDefaults.conversation,
          CONVERSATION_SCOPES,
          "settings.groupDefaults.conversation"
        ) || groupDefaults.conversation,
      requireMention:
        readBoolean(
          rawGroupDefaults.requireMention,
          "settings.groupDefaults.requireMention"
        ) ?? groupDefaults.requireMention
    }
  };

  const rawRoles: Record<string, RawRole> = { ...BUILT_IN_ROLES };
  if (raw.roles !== undefined) {
    for (const [name, value] of Object.entries(asObject(raw.roles, "roles"))) {
      if (name.startsWith("_")) continue;
      if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
        fail(
          `roles.${name}`,
          "role names use lowercase letters, digits, - and _"
        );
      }
      rawRoles[name] = readRawRole(value, `roles.${name}`);
    }
  }
  const roles = resolveRoles(rawRoles);

  const users = new Map<string, AccessUser>();
  if (raw.users !== undefined) {
    for (const [id, value] of Object.entries(asObject(raw.users, "users"))) {
      if (id.startsWith("_")) continue;
      const where = `users.${id}`;
      if (!/^\d+$/.test(id)) fail(where, "user ids are numeric Telegram ids");
      if (typeof value === "string") {
        requireRole(roles, value, where);
        users.set(id, { role: value, repos: ["*"], privateChat: true });
        continue;
      }
      const entry = asObject(value, where);
      assertKnownKeys(entry, ["role", "repos", "privateChat", "name"], where);
      const role = readString(entry.role, `${where}.role`);
      if (!role) fail(where, "role is required");
      requireRole(roles, role, `${where}.role`);
      users.set(id, {
        role,
        repos: readRepos(entry.repos, `${where}.repos`),
        privateChat:
          readBoolean(entry.privateChat, `${where}.privateChat`) ?? true
      });
    }
  }

  const groups = new Map<string, AccessGroup>();
  if (raw.groups !== undefined) {
    for (const [id, value] of Object.entries(asObject(raw.groups, "groups"))) {
      if (id.startsWith("_")) continue;
      const where = `groups.${id}`;
      if (!/^-\d+$/.test(id)) fail(where, "group ids are negative chat ids");
      const entry = asObject(value, where);
      assertKnownKeys(
        entry,
        [
          "maxRole",
          "defaultRole",
          "repos",
          "conversation",
          "requireMention",
          "name"
        ],
        where
      );
      const maxRole = readString(entry.maxRole, `${where}.maxRole`) || null;
      const defaultRole =
        readString(entry.defaultRole, `${where}.defaultRole`) || null;
      requireRole(roles, maxRole, `${where}.maxRole`);
      requireRole(roles, defaultRole, `${where}.defaultRole`);
      groups.set(id, {
        maxRole,
        defaultRole,
        repos: readRepos(entry.repos, `${where}.repos`),
        conversation:
          readEnum(
            entry.conversation,
            CONVERSATION_SCOPES,
            `${where}.conversation`
          ) || settings.groupDefaults.conversation,
        requireMention:
          readBoolean(entry.requireMention, `${where}.requireMention`) ??
          settings.groupDefaults.requireMention
      });
    }
  }

  return { source, settings, roles, users, groups };
}

export function buildLegacyAccessPolicy(
  telegram: AppConfig["telegram"]
): AccessPolicy {
  const restricted = new Set<Capability>(["access.manage"]);
  for (const command of telegram.adminOnlyCommands) {
    const capabilities = LEGACY_COMMAND_CAPABILITIES[command];
    if (!capabilities) {
      console.warn(
        `[access] ADMIN_ONLY_COMMANDS entry "${command}" does not map to a capability; ignoring it.`
      );
      continue;
    }
    capabilities.forEach((capability) => restricted.add(capability));
  }

  const roles = resolveRoles({
    admin: {
      description: "ADMIN_USER_IDS",
      capabilities: ["*"]
    },
    member: {
      description: "ALLOWED_USER_IDS without ADMIN_ONLY_COMMANDS",
      capabilities: ["*", ...[...restricted].map((cap) => `!${cap}`)]
    }
  });

  const admins = new Set(telegram.adminUserIds.map(String));
  const users = new Map<string, AccessUser>();
  for (const id of telegram.allowedUserIds.map(String)) {
    users.set(id, {
      role: admins.has(id) ? "admin" : "member",
      repos: ["*"],
      privateChat: true
    });
  }
  for (const id of telegram.groupAllowedUserIds.map(String)) {
    if (users.has(id)) continue;
    users.set(id, {
      role: admins.has(id) ? "admin" : "member",
      repos: ["*"],
      privateChat: false
    });
  }

  return {
    source: "environment (ALLOWED_USER_IDS / ADMIN_USER_IDS)",
    settings: {
      deny: { privateChats: "silent", groups: "silent", cooldownSeconds: 60 },
      audit: "denied",
      unknownGroups: "allow",
      groupDefaults: {
        conversation: telegram.groupConversationScope,
        requireMention: telegram.groupRequireMention
      }
    },
    roles,
    users,
    groups: new Map()
  };
}

export function resolveChatAccess(
  policy: AccessPolicy,
  chatId: string,
  chatType: string | undefined
): ChatAccess | null {
  if (chatType === "private") {
    return {
      chatId,
      kind: "private",
      group: null,
      conversation: "per-user",
      requireMention: false
    };
  }

  if (chatType !== "group" && chatType !== "supergroup") return null;

  const group =
    policy.groups.get(chatId) ||
    (policy.settings.unknownGroups === "allow"
      ? {
          maxRole: null,
          defaultRole: null,
          repos: ["*"],
          conversation: policy.settings.groupDefaults.conversation,
          requireMention: policy.settings.groupDefaults.requireMention
        }
      : null);
  if (!group) return null;

  return {
    chatId,
    kind: "group",
    group,
    conversation: group.conversation,
    requireMention: group.requireMention
  };
}

function mostRestrictive<T extends string>(
  order: readonly T[],
  left: T | undefined,
  right: T | undefined
): T | undefined {
  if (!left) return right;
  if (!right) return left;
  return order.indexOf(left) <= order.indexOf(right) ? left : right;
}

export function combineCodexSettings(
  base: RoleCodexSettings,
  cap: RoleCodexSettings | null
): RoleCodexSettings {
  if (!cap) return { ...base };
  const combined: RoleCodexSettings = {};
  const sandbox = mostRestrictive(SANDBOX_MODES, base.sandbox, cap.sandbox);
  const approval = mostRestrictive(
    APPROVAL_POLICIES,
    base.approval,
    cap.approval
  );
  if (sandbox) combined.sandbox = sandbox;
  if (approval) combined.approval = approval;
  if (base.network === false || cap.network === false) {
    combined.network = false;
  } else if (base.network !== undefined || cap.network !== undefined) {
    combined.network = base.network ?? cap.network;
  }
  return combined;
}

export function resolveAccessGrant(
  policy: AccessPolicy,
  chat: ChatAccess,
  userId: string
): GrantResult {
  const user = policy.users.get(userId);
  let roleName: string | null;
  let capName: string | null = null;
  let chatRepos = ["*"];

  if (chat.kind === "private") {
    if (!user) return { allowed: false, reason: "unknown_user" };
    if (!user.privateChat) {
      return { allowed: false, reason: "private_chat_disabled" };
    }
    roleName = user.role;
  } else {
    roleName = user?.role || chat.group?.defaultRole || null;
    capName = chat.group?.maxRole || null;
    chatRepos = chat.group?.repos || ["*"];
    if (!roleName) return { allowed: false, reason: "unknown_user" };
  }

  const role = policy.roles.get(roleName);
  const cap = capName ? policy.roles.get(capName) || null : null;
  if (!role || (capName && !cap)) {
    return { allowed: false, reason: "unknown_role" };
  }

  const capabilities = CAPABILITIES.filter(
    (capability) =>
      roleAllows(role, capability) && (!cap || roleAllows(cap, capability))
  );
  const capped =
    cap !== null &&
    cap.name !== role.name &&
    CAPABILITIES.some(
      (capability) =>
        roleAllows(role, capability) && !capabilities.includes(capability)
    );

  return {
    allowed: true,
    grant: {
      userId,
      chatId: chat.chatId,
      kind: chat.kind,
      role: role.name,
      roleLabel: capped ? `${role.name} (capped by ${cap.name})` : role.name,
      capabilities,
      userRepos: user?.repos || ["*"],
      chatRepos,
      codex: combineCodexSettings(role.codex, cap?.codex || null),
      denyFeedback:
        chat.kind === "private"
          ? policy.settings.deny.privateChats
          : policy.settings.deny.groups,
      audit: policy.settings.audit,
      cooldownSeconds: policy.settings.deny.cooldownSeconds
    }
  };
}

function scopeAllows(entries: string[], relativePath: string): boolean {
  return entries.some(
    (entry) =>
      entry === "*" ||
      relativePath === entry ||
      relativePath.startsWith(`${entry}/`)
  );
}

export function isRepoAllowed(
  grant: Pick<AccessGrant, "userRepos" | "chatRepos">,
  relativePath: string | null
): boolean {
  if (relativePath === null) return false;
  return (
    scopeAllows(grant.userRepos, relativePath) &&
    scopeAllows(grant.chatRepos, relativePath)
  );
}

export function loadAccessPolicyFile(
  file: string,
  groupDefaults: GroupDefaults
): AccessPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read access policy ${file}: ${toErrorMessage(error)}`,
      { cause: error }
    );
  }
  return parseAccessPolicy(parsed, { source: file, groupDefaults });
}

export interface AccessPolicySource {
  get(): AccessPolicy;
}

export class AccessPolicyStore implements AccessPolicySource {
  private policy: AccessPolicy;
  private readonly loader: () => AccessPolicy;

  constructor(loader: () => AccessPolicy) {
    this.loader = loader;
    this.policy = loader();
  }

  get(): AccessPolicy {
    return this.policy;
  }

  // Keeps the previous policy when the new one fails validation.
  reload(): AccessPolicy {
    const next = this.loader();
    this.policy = next;
    return next;
  }
}

export function createAccessPolicyStore(
  config: Pick<AppConfig, "access" | "telegram">
): AccessPolicyStore {
  const file = config.access.policyFile;
  if (!file) {
    return new AccessPolicyStore(() =>
      buildLegacyAccessPolicy(config.telegram)
    );
  }

  const groupDefaults: GroupDefaults = {
    conversation: config.telegram.groupConversationScope,
    requireMention: config.telegram.groupRequireMention
  };
  return new AccessPolicyStore(() => loadAccessPolicyFile(file, groupDefaults));
}
