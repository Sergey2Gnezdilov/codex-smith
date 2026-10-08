import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { loadAccessPolicyFile } from "../src/access/policy.js";

const require = createRequire(import.meta.url);
const eslintConfigUrl = new URL("../eslint.config.ts", import.meta.url);
const ecosystemConfigUrl = new URL("../ecosystem.config.ts", import.meta.url);

test("eslint config shim resolves the typescript source of truth", async () => {
  const [{ default: tsConfig }, { default: jsConfig }] = await Promise.all([
    import(eslintConfigUrl.href),
    import("../eslint.config.js")
  ]);

  assert.equal(Array.isArray(tsConfig), true);
  assert.equal(Array.isArray(jsConfig), true);
  assert.equal(jsConfig.length, tsConfig.length);
  const tsLastConfig = tsConfig.at(-1);
  const jsLastConfig = jsConfig.at(-1);
  const tsFiles =
    tsLastConfig && "files" in tsLastConfig ? tsLastConfig.files : [];
  const jsFiles =
    jsLastConfig && "files" in jsLastConfig ? jsLastConfig.files : [];
  assert.deepEqual(jsFiles, tsFiles);
});

test("ecosystem config points pm2 at the typescript runtime entry", async () => {
  const { default: tsConfig } = await import(ecosystemConfigUrl.href);
  const cjsConfig = require("../ecosystem.config.cjs");

  assert.equal(tsConfig.apps[0]?.script, "src/index.ts");
  assert.equal(tsConfig.apps[0]?.interpreter, "node_modules/.bin/tsx");
  assert.equal(cjsConfig.apps[0]?.script, tsConfig.apps[0]?.script);
  assert.equal(cjsConfig.apps[0]?.interpreter, tsConfig.apps[0]?.interpreter);
});

test("the example access policy is valid and covers each section", () => {
  const policy = loadAccessPolicyFile(
    fileURLToPath(new URL("../access-policy.example.json", import.meta.url)),
    { conversation: "per-user", requireMention: true }
  );

  assert.equal(policy.users.get("123456789")?.role, "admin");
  assert.deepEqual(policy.users.get("234567890")?.repos, [
    "api",
    "libs/shared"
  ]);
  assert.equal(policy.roles.get("reviewer")?.codex.sandbox, "read-only");
  assert.equal(policy.groups.get("-1001234567890")?.maxRole, "developer");
  assert.equal(policy.settings.unknownGroups, "deny");
});
