import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  AccessPolicyStore,
  buildLegacyAccessPolicy,
  combineCodexSettings,
  isRepoAllowed,
  loadAccessPolicyFile,
  parseAccessPolicy,
  resolveAccessGrant,
  resolveChatAccess,
  type AccessGrant,
  type AccessPolicy
} from "../src/access/policy.js";
import { isPathInside, relativeInside } from "../src/lib/paths.js";

const groupDefaults = {
  conversation: "per-user" as const,
  requireMention: true
};

function parse(raw: unknown): AccessPolicy {
  return parseAccessPolicy(raw, { source: "test", groupDefaults });
}

function grantFor(
  policy: AccessPolicy,
  userId: string,
  chatId = userId,
  chatType = "private"
): AccessGrant {
  const chat = resolveChatAccess(policy, chatId, chatType);
  if (!chat) throw new Error("chat denied");
  const result = resolveAccessGrant(policy, chat, userId);
  if (!result.allowed) throw new Error(`denied: ${result.reason}`);
  return result.grant;
}

test("built-in roles inherit capabilities upwards", () => {
  const policy = parse({
    users: { "1": "viewer", "2": "developer", "3": "operator", "4": "admin" }
  });

  const viewer = grantFor(policy, "1");
  const developer = grantFor(policy, "2");
  const operator = grantFor(policy, "3");
  const admin = grantFor(policy, "4");

  assert.equal(viewer.capabilities.includes("codex.prompt"), true);
  assert.equal(viewer.capabilities.includes("codex.exec"), false);
  assert.equal(viewer.codex.sandbox, "read-only");
  assert.equal(developer.capabilities.includes("codex.exec"), true);
  assert.equal(developer.capabilities.includes("dev.run"), false);
  assert.equal(developer.codex.sandbox, "workspace-write");
  assert.equal(operator.capabilities.includes("dev.run"), true);
  assert.equal(operator.capabilities.includes("gh.write"), false);
  assert.equal(admin.capabilities.includes("gh.write"), true);
  assert.equal(admin.capabilities.includes("access.manage"), true);
});

test("custom roles support namespaces, denials and codex overrides", () => {
  const policy = parse({
    roles: {
      reviewer: {
        inherits: "developer",
        capabilities: ["gh.*", "!gh.write"],
        codex: { sandbox: "read-only", network: false }
      }
    },
    users: { "1": { role: "reviewer", repos: ["./apps/web/"] } }
  });

  const grant = grantFor(policy, "1");
  assert.equal(grant.capabilities.includes("gh.test"), true);
  assert.equal(grant.capabilities.includes("gh.write"), false);
  assert.deepEqual(grant.codex, { sandbox: "read-only", network: false });
  assert.deepEqual(grant.userRepos, ["apps/web"]);
});

test("policy validation rejects typos instead of guessing", () => {
  assert.throws(() => parse({ user: {} }), /unknown key "user"/);
  assert.throws(
    () => parse({ roles: { x: { capabilities: ["gh.writ"] } } }),
    /unknown capability "gh.writ"/
  );
  assert.throws(
    () => parse({ users: { "1": "superuser" } }),
    /unknown role "superuser"/
  );
  assert.throws(
    () =>
      parse({
        roles: {
          a: { inherits: "b", capabilities: [] },
          b: { inherits: "a", capabilities: [] }
        }
      }),
    /inheritance cycle/
  );
  assert.throws(() => parse({ users: { "@me": "admin" } }), /numeric/);
  assert.throws(() => parse({ groups: { "1001": {} } }), /negative/);
  assert.throws(
    () => parse({ users: { "1": { role: "admin", repos: ["../etc"] } } }),
    /relative to WORKSPACE_ROOT/
  );
  assert.throws(() => parse({ version: 2 }), /version 1/);
});

test("unlisted users and private-chat opt-outs are denied", () => {
  const policy = parse({
    users: { "1": { role: "admin", privateChat: false } }
  });
  const chat = resolveChatAccess(policy, "2", "private");
  assert.ok(chat);
  assert.deepEqual(resolveAccessGrant(policy, chat, "2"), {
    allowed: false,
    reason: "unknown_user"
  });

  const own = resolveChatAccess(policy, "1", "private");
  assert.ok(own);
  assert.deepEqual(resolveAccessGrant(policy, own, "1"), {
    allowed: false,
    reason: "private_chat_disabled"
  });
});

test("unlisted groups are denied unless the policy allows them", () => {
  assert.equal(resolveChatAccess(parse({}), "-1001", "supergroup"), null);
  assert.ok(
    resolveChatAccess(
      parse({ settings: { unknownGroups: "allow" } }),
      "-1001",
      "supergroup"
    )
  );
  assert.equal(resolveChatAccess(parse({}), "-1001", "channel"), null);
});

test("group settings control conversation scope and mention requirement", () => {
  const policy = parse({
    settings: { groupDefaults: { requireMention: false } },
    groups: { "-1001": { conversation: "shared" }, "-1002": {} }
  });

  assert.deepEqual(
    [
      resolveChatAccess(policy, "-1001", "group")?.conversation,
      resolveChatAccess(policy, "-1001", "group")?.requireMention,
      resolveChatAccess(policy, "-1002", "group")?.conversation
    ],
    ["shared", false, "per-user"]
  );
});

test("repository scope is the intersection of user and group scopes", () => {
  const policy = parse({
    users: { "1": { role: "developer", repos: ["alpha", "libs"] } },
    groups: { "-1001": { repos: ["alpha", "beta"] } }
  });
  const grant = grantFor(policy, "1", "-1001", "supergroup");

  assert.equal(isRepoAllowed(grant, "alpha"), true);
  assert.equal(isRepoAllowed(grant, "alpha/packages/core"), true);
  assert.equal(isRepoAllowed(grant, "alphabet"), false);
  assert.equal(isRepoAllowed(grant, "beta"), false);
  assert.equal(isRepoAllowed(grant, "libs"), false);
  assert.equal(isRepoAllowed(grant, ""), false);
  assert.equal(isRepoAllowed(grant, null), false);
});

test("capping combines codex settings by taking the stricter value", () => {
  assert.deepEqual(
    combineCodexSettings(
      { sandbox: "danger-full-access", approval: "never", network: true },
      { sandbox: "workspace-write", approval: "on-request" }
    ),
    { sandbox: "workspace-write", approval: "on-request", network: true }
  );
  assert.deepEqual(
    combineCodexSettings({ network: true }, { network: false }),
    { network: false }
  );
  assert.deepEqual(combineCodexSettings({}, { sandbox: "read-only" }), {
    sandbox: "read-only"
  });
});

test("legacy environment policy keeps the old allowlist semantics", () => {
  const policy = buildLegacyAccessPolicy({
    botToken: "x",
    apiBase: "https://api.telegram.org",
    allowedUserIds: ["1", "2"],
    groupAllowedUserIds: ["3"],
    adminUserIds: ["1"],
    adminOnlyCommands: ["restart", "gh"],
    groupConversationScope: "per-user",
    groupRequireMention: true,
    proactiveUserIds: []
  });

  const admin = grantFor(policy, "1");
  const member = grantFor(policy, "2");
  assert.equal(admin.capabilities.includes("gh.write"), true);
  assert.equal(member.capabilities.includes("gh.read"), false);
  assert.equal(member.capabilities.includes("bot.restart"), false);
  assert.equal(member.capabilities.includes("access.manage"), false);
  assert.equal(member.capabilities.includes("shell.run"), true);
  assert.deepEqual(member.codex, {});

  const groupOnly = resolveChatAccess(policy, "3", "private");
  assert.ok(groupOnly);
  assert.equal(resolveAccessGrant(policy, groupOnly, "3").allowed, false);
  assert.equal(
    grantFor(policy, "3", "-1001", "supergroup").capabilities.length > 0,
    true
  );
});

test("a failed reload keeps the previous policy", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-smith-policy-"));
  const file = path.join(dir, "access-policy.json");
  fs.writeFileSync(file, JSON.stringify({ users: { "1": "admin" } }));
  const store = new AccessPolicyStore(() =>
    loadAccessPolicyFile(file, groupDefaults)
  );

  fs.writeFileSync(file, "{ not json");
  assert.throws(() => store.reload(), /Cannot read access policy/);
  assert.equal(store.get().users.get("1")?.role, "admin");

  fs.writeFileSync(file, JSON.stringify({ users: { "1": "viewer" } }));
  store.reload();
  assert.equal(store.get().users.get("1")?.role, "viewer");
});

test("path containment resolves symlinks that escape the root", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "codex-smith-paths-"));
  const root = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  fs.mkdirSync(path.join(root, "alpha"), { recursive: true });
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, "escape"));

  assert.equal(isPathInside(root, path.join(root, "alpha")), true);
  assert.equal(relativeInside(root, path.join(root, "alpha")), "alpha");
  assert.equal(isPathInside(root, path.join(root, "escape")), false);
  assert.equal(isPathInside(root, path.join(root, "escape", "new")), false);
  assert.equal(isPathInside(root, path.join(root, "..", "outside")), false);
  assert.equal(relativeInside(root, root), "");
});
