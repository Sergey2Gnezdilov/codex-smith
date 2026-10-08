import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import { simpleGit } from "simple-git";
import { Octokit } from "@octokit/rest";
import type { AppConfig } from "../../config.js";
import { toErrorMessage } from "../../lib/errors.js";
import { parseCommandLine } from "../../runner/commandLine.js";
import { t, type Locale } from "../../bot/i18n.js";
import { isPathInside } from "../../lib/paths.js";
import {
  getCurrentAccessState,
  resolveConversationKey
} from "../../bot/accessContext.js";

interface GitStatusResult {
  files: Array<{ path: string }>;
}

interface GitBranchResult {
  current: string;
}

interface GitRemoteResult {
  name: string;
}

interface GitLike {
  init?(bare?: boolean, options?: string[]): Promise<unknown>;
  status(): Promise<GitStatusResult>;
  add(pathspec: string): Promise<unknown>;
  commit(message: string): Promise<unknown>;
  branch(): Promise<GitBranchResult>;
  push(...args: unknown[]): Promise<unknown>;
  getRemotes(verbose: boolean): Promise<GitRemoteResult[]>;
  addRemote(name: string, url: string): Promise<unknown>;
  remote(args: string[]): Promise<unknown>;
}

interface ExecuteInput {
  text: string;
  workdir?: string;
  locale?: Locale;
  chatId?: string | number;
}

export interface GitHubTestJob {
  jobId: string;
  status: "running" | "passed" | "failed";
  workdir: string;
  command: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  output: string;
}

interface GitHubSkillResult {
  text: string;
  testJobId?: string;
  switchToRepo?: string;
}

type PendingGitHubActionKind = "commit_and_push" | "push" | "create_repo";

export type GitHubRequestKind = "help" | "read" | "test" | "write" | "confirm";

interface PendingGitHubAction {
  kind: PendingGitHubActionKind;
  rawText: string;
  workdir?: string;
  ownerUserId: string;
}

function buildAutoCommitMessage(status: GitStatusResult): string {
  const fileCount = status.files.length;
  const preview = status.files
    .slice(0, 3)
    .map((item) => item.path)
    .join(", ");
  return `chore: update ${fileCount} file(s)${preview ? ` (${preview})` : ""}`;
}

function extractQuotedMessage(text: string): string {
  const matched = text.match(/["“](.+?)["”]/);
  return matched?.[1]?.trim() || "";
}

function slugifyRepoName(value: string): string {
  return value
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function inferRepoNameFromProjectPhrase(text: string): string {
  const patterns = [
    /(?:create|build|make|start)\s+(?:a|an|the)?\s*([a-z0-9][a-z0-9\s-]{1,80})\s+(?:game|app|bot|site|tool|project|repo(?:sitory)?)/i,
    /(?:创建|新建|做)\s*(?:一个|一個|个)?\s*([a-zA-Z0-9\s-]{1,80})\s*(?:游戏|遊戲|应用|應用|机器人|機器人|网站|網站|工具|项目|項目|仓库|倉庫)/u
  ];
  const leadingDescriptors =
    /\b(?:web[- ]based|web|mobile|desktop|telegram|typescript|react|vue|next(?:\.js)?|node(?:\.js)?|simple|local|new)\b/gi;

  for (const pattern of patterns) {
    const matched = text.match(pattern);
    const candidate = matched?.[1]
      ?.replace(leadingDescriptors, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!candidate) continue;

    const repoName = slugifyRepoName(candidate);
    if (repoName) return repoName;
  }

  return "";
}

function extractRepoName(text: string): string {
  const patterns = [
    /(?:创建仓库|create repo(?:sitory)?|repo)\s*[:：]?\s*([a-zA-Z0-9._-]+)/i,
    /(?:仓库名|repository)\s*[:：]?\s*([a-zA-Z0-9._-]+)/i
  ];

  for (const pattern of patterns) {
    const matched = text.match(pattern);
    if (matched?.[1]) return matched[1];
  }

  const inferredRepoName = inferRepoNameFromProjectPhrase(text);
  if (inferredRepoName) return inferredRepoName;

  return "";
}

function pickJobId(text: string, fallbackJobId: string): string {
  const matched = text.match(/(?:job|任务|#)\s*([a-zA-Z0-9-]+)/i);
  return matched?.[1] || fallbackJobId;
}

export class GitHubSkill {
  readonly config: Pick<AppConfig, "github" | "workspace">;
  readonly octokit: Octokit | null;
  readonly testJobs: Map<string, GitHubTestJob>;
  readonly pendingActions: Map<string, PendingGitHubAction>;
  latestTestJobId: string;

  constructor({ config }: { config: Pick<AppConfig, "github" | "workspace"> }) {
    this.config = config;
    this.octokit = config.github.token
      ? new Octokit({ auth: config.github.token })
      : null;
    this.testJobs = new Map();
    this.pendingActions = new Map();
    this.latestTestJobId = "";
  }

  getGit(workdir?: string): GitLike {
    return simpleGit({
      baseDir: workdir || this.config.github.defaultWorkdir
    }) as unknown as GitLike;
  }

  supports(text: string): boolean {
    const normalized = text.toLowerCase();
    return (
      normalized.startsWith("/gh") ||
      /github|git push|git commit|提交|推送|创建仓库|create repo|create repository|new repo|repository|playwright|测试状态|run test|运行测试/.test(
        normalized
      )
    );
  }

  private isExplicitCommand(text: string): boolean {
    return text.trim().startsWith("/gh");
  }

  // Mirrors the dispatch in execute() so callers can check access first.
  classifyRequest(text: string): GitHubRequestKind {
    const stripped = text.replace(/^\/gh(@\w+)?\s*/i, "").trim();
    const normalized = stripped.toLowerCase();
    if (!stripped || normalized === "help") return "help";
    if (normalized === "confirm") return "confirm";
    if (this.classifyWriteAction(normalized)) return "write";
    if (/创建仓库|create repo|new repo/.test(normalized)) return "write";
    if (/测试状态|test status|status/.test(normalized)) return "read";
    if (/运行测试|run test|playwright|e2e/.test(normalized)) return "test";
    return "help";
  }

  private classifyWriteAction(
    normalized: string
  ): PendingGitHubActionKind | null {
    if (/创建仓库|create repo|new repo/.test(normalized)) {
      return "create_repo";
    }

    if (/推送|\bpush\b/.test(normalized) && !/提交|commit/.test(normalized)) {
      return "push";
    }

    if (/提交|推送|commit|push/.test(normalized)) {
      return "commit_and_push";
    }

    return null;
  }

  private queuePendingAction(
    chatId: string | number,
    action: PendingGitHubAction
  ): void {
    this.pendingActions.set(resolveConversationKey(chatId), action);
  }

  // A pending write can only be confirmed by the user who requested it.
  private popPendingAction(
    chatId: string | number
  ): PendingGitHubAction | null {
    const key = resolveConversationKey(chatId);
    const action = this.pendingActions.get(key) || null;
    const userId = getCurrentAccessState()?.userId || "";
    if (!action || action.ownerUserId !== userId) {
      return null;
    }
    this.pendingActions.delete(key);
    return action;
  }

  private async executePendingAction(
    action: PendingGitHubAction,
    locale: Locale
  ): Promise<GitHubSkillResult> {
    switch (action.kind) {
      case "create_repo":
        return this.createRepoFromText(action.rawText, action.workdir, locale);
      case "push":
        return this.pushOnly(action.workdir, locale);
      case "commit_and_push":
        return this.commitAndPush(action.rawText, action.workdir, locale);
      default:
        return { text: this.helpText(locale) };
    }
  }

  private isInsideWorkspaceRoot(targetPath: string): boolean {
    return isPathInside(this.config.workspace.root, targetPath);
  }

  private resolveSiblingRepoPath(
    repoName: string,
    workdir: string | undefined,
    locale: Locale
  ): { targetPath: string; relativePath: string } {
    const currentWorkdir = path.resolve(
      workdir || this.config.github.defaultWorkdir
    );
    const currentRepoDir = fs.existsSync(path.join(currentWorkdir, ".git"))
      ? currentWorkdir
      : this.config.workspace.root;
    const targetPath = path.resolve(path.dirname(currentRepoDir), repoName);

    if (!this.isInsideWorkspaceRoot(targetPath)) {
      throw new Error(t(locale, "targetOutsideWorkspaceRoot"));
    }

    return {
      targetPath,
      relativePath: path.relative(this.config.workspace.root, targetPath) || "."
    };
  }

  async execute({
    text,
    workdir,
    locale = "en",
    chatId
  }: ExecuteInput): Promise<GitHubSkillResult> {
    const explicit = this.isExplicitCommand(text);
    const stripped = text.replace(/^\/gh(@\w+)?\s*/i, "").trim();
    const normalized = stripped.toLowerCase();
    const writeAction = this.classifyWriteAction(normalized);

    if (!stripped || normalized === "help") {
      return { text: this.helpText(locale) };
    }

    if (normalized === "confirm") {
      if (chatId === undefined || chatId === null) {
        return { text: t(locale, "githubNoPendingConfirmation") };
      }

      const pendingAction = this.popPendingAction(chatId);
      if (!pendingAction) {
        return { text: t(locale, "githubNoPendingConfirmation") };
      }

      return this.executePendingAction(pendingAction, locale);
    }

    if (writeAction && !explicit) {
      return { text: t(locale, "githubExplicitWriteRequired") };
    }

    if (writeAction && explicit && chatId !== undefined && chatId !== null) {
      this.queuePendingAction(chatId, {
        kind: writeAction,
        rawText: stripped,
        workdir,
        ownerUserId: getCurrentAccessState()?.userId || ""
      });
      return {
        text: t(locale, "githubWriteConfirmationRequired", {
          command: "/gh confirm"
        })
      };
    }

    if (/创建仓库|create repo|new repo/.test(normalized)) {
      return this.createRepoFromText(stripped, workdir, locale);
    }

    if (/测试状态|test status|status/.test(normalized)) {
      return this.readTestStatusFromText(stripped, locale);
    }

    if (/运行测试|run test|playwright|e2e/.test(normalized)) {
      return this.startTests(workdir, locale);
    }

    if (/推送|\bpush\b/.test(normalized) && !/提交|commit/.test(normalized)) {
      return this.pushOnly(workdir, locale);
    }

    if (/提交|推送|commit|push/.test(normalized)) {
      return this.commitAndPush(stripped, workdir, locale);
    }

    return { text: this.helpText(locale) };
  }

  helpText(locale: Locale = "en"): string {
    return t(locale, "githubHelp");
  }

  async commitAndPush(
    rawText: string,
    workdir?: string,
    locale: Locale = "en"
  ): Promise<GitHubSkillResult> {
    const git = this.getGit(workdir);
    const status = await git.status();
    if (!status.files.length) {
      return { text: t(locale, "githubNoChanges") };
    }

    const explicitMessage = extractQuotedMessage(rawText);
    const commitMessage = explicitMessage || buildAutoCommitMessage(status);

    await git.add(".");
    await git.commit(commitMessage);

    const branchInfo = await git.branch();
    const branch = branchInfo.current || this.config.github.defaultBranch;

    try {
      await git.push("origin", branch);
      return {
        text: t(locale, "githubCommitAndPushSucceeded", {
          workdir: workdir || this.config.github.defaultWorkdir,
          branch,
          message: commitMessage
        })
      };
    } catch (error: unknown) {
      return {
        text: t(locale, "githubCommitSucceededPushFailed", {
          workdir: workdir || this.config.github.defaultWorkdir,
          branch,
          message: commitMessage,
          error: toErrorMessage(error)
        })
      };
    }
  }

  async pushOnly(
    workdir?: string,
    locale: Locale = "en"
  ): Promise<GitHubSkillResult> {
    const git = this.getGit(workdir);
    const branchInfo = await git.branch();
    const branch = branchInfo.current || this.config.github.defaultBranch;
    await git.push("origin", branch);
    return {
      text: t(locale, "githubPushSucceeded", {
        workdir: workdir || this.config.github.defaultWorkdir,
        branch
      })
    };
  }

  async createRepoFromText(
    rawText: string,
    workdir?: string,
    locale: Locale = "en"
  ): Promise<GitHubSkillResult> {
    if (!this.octokit) {
      return { text: t(locale, "githubMissingToken") };
    }

    const repoName = extractRepoName(rawText);
    if (!repoName) {
      return { text: t(locale, "githubRepoNameParseFailed") };
    }

    const { targetPath, relativePath } = this.resolveSiblingRepoPath(
      repoName,
      workdir,
      locale
    );
    if (fs.existsSync(targetPath)) {
      return {
        text: t(locale, "githubRepoLocalPathExists", {
          path: targetPath
        })
      };
    }

    const isPrivate = !/public|公开/.test(rawText.toLowerCase());
    const { data: repo } = await this.octokit.repos.createForAuthenticatedUser({
      name: repoName,
      private: isPrivate,
      auto_init: false
    });

    fs.mkdirSync(targetPath, { recursive: false });
    const git = this.getGit(targetPath);
    if (!git.init) {
      throw new Error("git init is unavailable for repository creation.");
    }

    await git.init(false, [
      "--initial-branch",
      this.config.github.defaultBranch
    ]);
    await git.addRemote("origin", repo.clone_url);

    return {
      text: t(locale, "githubRepoCreated", {
        workdir: targetPath,
        relativeWorkdir: relativePath,
        repo: repo.full_name,
        url: repo.html_url,
        branch: this.config.github.defaultBranch
      }),
      switchToRepo: relativePath
    };
  }

  async startTests(
    workdir?: string,
    locale: Locale = "en"
  ): Promise<GitHubSkillResult> {
    const jobId = `job-${Date.now()}`;
    const command = this.config.github.e2eCommand;
    const argv = parseCommandLine(command);
    if (!argv.length) {
      return { text: t(locale, "githubEmptyTestCommand") };
    }

    const [binary = "", ...args] = argv;
    const job: GitHubTestJob = {
      jobId,
      status: "running",
      workdir: workdir || this.config.github.defaultWorkdir,
      command,
      startedAt: new Date().toISOString(),
      finishedAt: "",
      exitCode: null,
      output: ""
    };

    const child = spawn(binary, args, {
      cwd: workdir || this.config.github.defaultWorkdir,
      env: process.env,
      shell: false
    });

    const appendOutput = (chunk: string): void => {
      job.output = `${job.output}${chunk}`;
      if (job.output.length > 5000) {
        job.output = job.output.slice(-5000);
      }
    };

    child.stdout.on("data", (chunk: Buffer | string) =>
      appendOutput(String(chunk))
    );
    child.stderr.on("data", (chunk: Buffer | string) =>
      appendOutput(String(chunk))
    );
    child.on("close", (exitCode) => {
      job.status = exitCode === 0 ? "passed" : "failed";
      job.exitCode = exitCode;
      job.finishedAt = new Date().toISOString();
    });
    child.on("error", (error: Error) => {
      job.status = "failed";
      job.exitCode = -1;
      job.finishedAt = new Date().toISOString();
      appendOutput(`\n[spawn error] ${error.message}`);
    });

    this.testJobs.set(jobId, job);
    this.latestTestJobId = jobId;

    return {
      text: t(locale, "githubTestsStarted", {
        jobId,
        workdir: job.workdir,
        command
      }),
      testJobId: jobId
    };
  }

  async readTestStatusFromText(
    text: string,
    locale: Locale = "en"
  ): Promise<GitHubSkillResult> {
    const targetJobId = pickJobId(text, this.latestTestJobId);
    if (!targetJobId) {
      return { text: t(locale, "githubNoTestJobs") };
    }

    const job = this.testJobs.get(targetJobId);
    if (!job) {
      return {
        text: t(locale, "githubTestJobNotFound", { jobId: targetJobId })
      };
    }

    return {
      text: t(locale, "githubTestStatus", { job }),
      testJobId: job.jobId
    };
  }

  async getTestStatus(
    jobId = this.latestTestJobId,
    locale: Locale = "en"
  ): Promise<GitHubSkillResult | null> {
    if (!jobId) return null;
    return this.readTestStatusFromText(`test status ${jobId}`, locale);
  }
}
