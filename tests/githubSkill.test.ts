import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { GitHubSkill } from "../src/orchestrator/skills/githubSkill.js";

function createGitHubConfig(workspaceRoot = process.cwd()) {
  return {
    workspace: {
      root: workspaceRoot
    },
    github: {
      token: "",
      defaultWorkdir: workspaceRoot,
      defaultBranch: "main",
      e2eCommand: "npm test"
    }
  };
}

test("github skill returns no-job text when test status is requested before any run", async () => {
  const skill = new GitHubSkill({
    config: createGitHubConfig()
  });

  const result = await skill.readTestStatusFromText("test status", "en");

  assert.match(result.text, /No test jobs|no test jobs/i);
});

test("github skill returns commit-and-push success text from a stub git client", async () => {
  const skill = new GitHubSkill({
    config: createGitHubConfig()
  });

  skill.getGit = () => ({
    status: async () => ({
      files: [{ path: "src/index.ts" }]
    }),
    add: async () => {},
    commit: async () => {},
    branch: async () => ({
      current: "main"
    }),
    push: async () => {},
    getRemotes: async () => [],
    addRemote: async () => {},
    remote: async () => {}
  });

  const result = await skill.commitAndPush(
    '/gh commit "feat: migrate"',
    process.cwd(),
    "en"
  );

  assert.match(result.text, /Commit and push succeeded/);
  assert.match(result.text, /feat: migrate/);
});

test("github skill recognizes english create repo requests in plain text", () => {
  const skill = new GitHubSkill({
    config: createGitHubConfig()
  });

  assert.equal(
    skill.supports("create repo five-in-a-row and then build the app"),
    true
  );
});

test("github skill creates a sibling repo under workspace root and returns a repo switch target", async () => {
  const workspaceRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "claws-github-skill-")
  );
  const currentRepo = path.join(workspaceRoot, "codex-smith");
  fs.mkdirSync(path.join(currentRepo, ".git"), { recursive: true });

  const skill = new GitHubSkill({
    config: createGitHubConfig(workspaceRoot)
  });

  const createdRepos: Array<{ name: string; private: boolean }> = [];
  (skill as any).octokit = {
    repos: {
      createForAuthenticatedUser: async ({
        name,
        private: isPrivate
      }: {
        name: string;
        private: boolean;
      }) => {
        createdRepos.push({ name, private: isPrivate });
        return {
          data: {
            clone_url: `https://github.com/example/${name}.git`,
            full_name: `example/${name}`,
            html_url: `https://github.com/example/${name}`
          }
        };
      }
    }
  };

  const initCalls: Array<{ workdir: string; options?: unknown[] }> = [];
  const remoteCalls: Array<{ workdir: string; name: string; url: string }> = [];
  skill.getGit = (workdir?: string) =>
    ({
      init: async (_bare?: unknown, options?: unknown[]) => {
        if (!workdir) throw new Error("workdir required");
        initCalls.push({ workdir, options });
        fs.mkdirSync(path.join(workdir, ".git"), { recursive: true });
      },
      status: async () => ({ files: [] }),
      add: async () => {},
      commit: async () => {},
      branch: async () => ({ current: "main" }),
      push: async () => {},
      getRemotes: async () => [],
      addRemote: async (name: string, url: string) => {
        if (!workdir) throw new Error("workdir required");
        remoteCalls.push({ workdir, name, url });
      },
      remote: async () => {}
    }) as any;

  const result = await skill.createRepoFromText(
    "create repo five-in-a-row",
    currentRepo,
    "en"
  );

  const createdPath = path.join(workspaceRoot, "five-in-a-row");
  assert.equal(fs.existsSync(createdPath), true);
  assert.deepEqual(createdRepos, [{ name: "five-in-a-row", private: true }]);
  assert.equal(initCalls.length, 1);
  assert.equal(initCalls[0].workdir, createdPath);
  assert.deepEqual(initCalls[0].options, ["--initial-branch", "main"]);
  assert.deepEqual(remoteCalls, [
    {
      workdir: createdPath,
      name: "origin",
      url: "https://github.com/example/five-in-a-row.git"
    }
  ]);
  assert.equal(result.switchToRepo, "five-in-a-row");
  assert.match(result.text, /Repository created/);
  assert.match(result.text, /five-in-a-row/);
});

test("github skill infers a repo name from a natural-language creation request", async () => {
  const workspaceRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "claws-github-skill-natural-language-")
  );
  const currentRepo = path.join(workspaceRoot, "codex-smith");
  fs.mkdirSync(path.join(currentRepo, ".git"), { recursive: true });

  const skill = new GitHubSkill({
    config: createGitHubConfig(workspaceRoot)
  });

  const createdRepos: Array<{ name: string; private: boolean }> = [];
  (skill as any).octokit = {
    repos: {
      createForAuthenticatedUser: async ({
        name,
        private: isPrivate
      }: {
        name: string;
        private: boolean;
      }) => {
        createdRepos.push({ name, private: isPrivate });
        return {
          data: {
            clone_url: `https://github.com/example/${name}.git`,
            full_name: `example/${name}`,
            html_url: `https://github.com/example/${name}`
          }
        };
      }
    }
  };

  skill.getGit = (workdir?: string) =>
    ({
      init: async () => {
        if (!workdir) throw new Error("workdir required");
        fs.mkdirSync(path.join(workdir, ".git"), { recursive: true });
      },
      status: async () => ({ files: [] }),
      add: async () => {},
      commit: async () => {},
      branch: async () => ({ current: "main" }),
      push: async () => {},
      getRemotes: async () => [],
      addRemote: async () => {},
      remote: async () => {}
    }) as any;

  const result = await skill.createRepoFromText(
    "create repo, create a web-based five-in-a-row game, push them and run it. requiring attribution to Codex Smith.",
    currentRepo,
    "en"
  );

  assert.deepEqual(createdRepos, [{ name: "five-in-a-row", private: true }]);
  assert.equal(result.switchToRepo, "five-in-a-row");
  assert.match(result.text, /five-in-a-row/);
});

test("github skill refuses plain-text write actions and points users to explicit /gh commands", async () => {
  const skill = new GitHubSkill({
    config: createGitHubConfig()
  });

  const result = await skill.execute({
    text: "create repo five-in-a-row and push it",
    workdir: process.cwd(),
    locale: "en",
    chatId: 1
  });

  assert.match(result.text, /explicit/i);
  assert.match(result.text, /\/gh create repo/i);
  assert.match(result.text, /\/gh push/i);
});

test("github skill requires confirmation before explicit push and executes it on /gh confirm", async () => {
  const skill = new GitHubSkill({
    config: createGitHubConfig()
  });
  const calls: string[] = [];

  skill.getGit = () => ({
    status: async () => ({ files: [] }),
    add: async () => {},
    commit: async () => {},
    branch: async () => ({
      current: "main"
    }),
    push: async () => {
      calls.push("push");
    },
    getRemotes: async () => [],
    addRemote: async () => {},
    remote: async () => {}
  });

  const queued = await skill.execute({
    text: "/gh push",
    workdir: process.cwd(),
    locale: "en",
    chatId: 1
  });
  assert.match(queued.text, /requires confirmation/i);
  assert.match(queued.text, /\/gh confirm/i);
  assert.deepEqual(calls, []);

  const confirmed = await skill.execute({
    text: "/gh confirm",
    workdir: process.cwd(),
    locale: "en",
    chatId: 1
  });
  assert.match(confirmed.text, /Push succeeded/i);
  assert.deepEqual(calls, ["push"]);
});
