import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn, type ChildProcess } from "node:child_process";
import { toErrorMessage } from "../lib/errors.js";

export type DevServerPackageManager = "npm" | "pnpm" | "yarn" | "bun";
export type DevServerScriptName = "dev" | "start";
export type DevServerLifecycleStatus =
  "stopped" | "running" | "exited" | "failed";

export interface DevServerStatus {
  running: boolean;
  status: DevServerLifecycleStatus;
  workdir: string;
  startedByChatId: string | null;
  command: string | null;
  packageManager: DevServerPackageManager | null;
  scriptName: DevServerScriptName | null;
  pid: number | null;
  startedAt: string | null;
  exitedAt: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  detectedUrl: string | null;
}

type StartSuccessResult = {
  started: true;
  status: DevServerStatus;
  command: string;
  packageManager: DevServerPackageManager;
  scriptName: DevServerScriptName;
};

type StartAlreadyRunningResult = {
  started: false;
  reason: "already_running";
  status: DevServerStatus;
};

type StartNoPackageResult = {
  started: false;
  reason: "no_package_json";
};

type StartNoScriptResult = {
  started: false;
  reason: "no_script";
  availableScripts: string[];
};

type StartSpawnErrorResult = {
  started: false;
  reason: "spawn_error";
  error: string;
};

export type DevServerStartResult =
  | StartSuccessResult
  | StartAlreadyRunningResult
  | StartNoPackageResult
  | StartNoScriptResult
  | StartSpawnErrorResult;

interface DevServerEntry {
  status: DevServerStatus;
  outputTail: string;
  child: ChildProcess | null;
  stopRequested: boolean;
}

interface PackageJsonLike {
  scripts?: Record<string, string>;
}

interface DevServerManagerOptions {
  spawnProcess?: SpawnProcessLike;
  maxLogChars?: number;
}

interface SpawnProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
}

type SpawnProcessLike = (
  command: string,
  args: string[],
  options: SpawnProcessOptions
) => ChildProcess;

function defaultStatus(workdir: string): DevServerStatus {
  return {
    running: false,
    status: "stopped",
    workdir,
    startedByChatId: null,
    command: null,
    packageManager: null,
    scriptName: null,
    pid: null,
    startedAt: null,
    exitedAt: null,
    exitCode: null,
    signal: null,
    detectedUrl: null
  };
}

function cloneStatus(status: DevServerStatus): DevServerStatus {
  return { ...status };
}

function trimOutputTail(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return value.slice(-maxChars);
}

function readPackageJson(workdir: string): PackageJsonLike | null {
  const packageJsonPath = path.join(workdir, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }

  return JSON.parse(
    fs.readFileSync(packageJsonPath, "utf8")
  ) as PackageJsonLike;
}

function detectPackageManager(workdir: string): DevServerPackageManager {
  if (
    fs.existsSync(path.join(workdir, "bun.lockb")) ||
    fs.existsSync(path.join(workdir, "bun.lock"))
  ) {
    return "bun";
  }
  if (fs.existsSync(path.join(workdir, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (fs.existsSync(path.join(workdir, "yarn.lock"))) {
    return "yarn";
  }
  return "npm";
}

function buildCommand(
  packageManager: DevServerPackageManager,
  scriptName: DevServerScriptName
): { command: string; args: string[]; displayCommand: string } {
  switch (packageManager) {
    case "yarn":
      return {
        command: "yarn",
        args: [scriptName],
        displayCommand: `yarn ${scriptName}`
      };
    case "bun":
      return {
        command: "bun",
        args: ["run", scriptName],
        displayCommand: `bun run ${scriptName}`
      };
    case "pnpm":
      return {
        command: "pnpm",
        args: ["run", scriptName],
        displayCommand: `pnpm run ${scriptName}`
      };
    default:
      return {
        command: "npm",
        args: ["run", scriptName],
        displayCommand: `npm run ${scriptName}`
      };
  }
}

function detectUrl(output: string): string | null {
  const matched = output.match(/https?:\/\/[^\s"'`]+/);
  return matched?.[0] || null;
}

export class DevServerManager {
  private readonly spawnProcess: SpawnProcessLike;
  private readonly maxLogChars: number;
  private readonly entries: Map<string, DevServerEntry>;

  constructor({
    spawnProcess = (command, args, options) => spawn(command, args, options),
    maxLogChars = 12000
  }: DevServerManagerOptions = {}) {
    this.spawnProcess = spawnProcess;
    this.maxLogChars = maxLogChars;
    this.entries = new Map();
  }

  private resolveWorkdir(workdir: string): string {
    return path.resolve(workdir);
  }

  private ensureEntry(workdir: string): DevServerEntry {
    const resolvedWorkdir = this.resolveWorkdir(workdir);
    const existing = this.entries.get(resolvedWorkdir);
    if (existing) {
      return existing;
    }

    const entry: DevServerEntry = {
      status: defaultStatus(resolvedWorkdir),
      outputTail: "",
      child: null,
      stopRequested: false
    };
    this.entries.set(resolvedWorkdir, entry);
    return entry;
  }

  private appendOutput(entry: DevServerEntry, chunk: unknown): void {
    entry.outputTail = trimOutputTail(
      `${entry.outputTail}${String(chunk || "")}`,
      this.maxLogChars
    );
    if (!entry.status.detectedUrl) {
      entry.status.detectedUrl = detectUrl(entry.outputTail);
    }
  }

  getStatus(workdir: string): DevServerStatus {
    return cloneStatus(this.ensureEntry(workdir).status);
  }

  getLogs(workdir: string): string {
    const output = this.ensureEntry(workdir).outputTail.trim();
    return output || "(no logs yet)";
  }

  getUrl(workdir: string): string | null {
    return this.ensureEntry(workdir).status.detectedUrl;
  }

  async start({
    workdir,
    chatId
  }: {
    workdir: string;
    chatId: string | number;
  }): Promise<DevServerStartResult> {
    const resolvedWorkdir = this.resolveWorkdir(workdir);
    const entry = this.ensureEntry(resolvedWorkdir);

    if (entry.status.running) {
      return {
        started: false,
        reason: "already_running",
        status: cloneStatus(entry.status)
      };
    }

    const packageJson = readPackageJson(resolvedWorkdir);
    if (!packageJson) {
      return {
        started: false,
        reason: "no_package_json"
      };
    }

    const availableScripts = Object.keys(packageJson.scripts || {});
    const scriptName = (["dev", "start"] as const).find((candidate) =>
      Boolean(packageJson.scripts?.[candidate])
    );
    if (!scriptName) {
      return {
        started: false,
        reason: "no_script",
        availableScripts
      };
    }

    const packageManager = detectPackageManager(resolvedWorkdir);
    const commandInfo = buildCommand(packageManager, scriptName);

    try {
      const child = this.spawnProcess(commandInfo.command, commandInfo.args, {
        cwd: resolvedWorkdir,
        env: process.env,
        shell: false
      });

      entry.child = child;
      entry.stopRequested = false;
      entry.outputTail = "";
      entry.status = {
        running: true,
        status: "running",
        workdir: resolvedWorkdir,
        startedByChatId: String(chatId),
        command: commandInfo.displayCommand,
        packageManager,
        scriptName,
        pid: child.pid || null,
        startedAt: new Date().toISOString(),
        exitedAt: null,
        exitCode: null,
        signal: null,
        detectedUrl: null
      };

      child.stdout?.on("data", (chunk) => this.appendOutput(entry, chunk));
      child.stderr?.on("data", (chunk) => this.appendOutput(entry, chunk));
      child.on("error", (error) => {
        entry.status.running = false;
        entry.status.status = "failed";
        entry.status.exitedAt = new Date().toISOString();
        entry.status.exitCode = -1;
        entry.status.signal = null;
        this.appendOutput(entry, `\n[spawn error] ${toErrorMessage(error)}`);
      });
      child.on("close", (exitCode, signal) => {
        entry.child = null;
        entry.status.running = false;
        entry.status.exitedAt = new Date().toISOString();
        entry.status.exitCode = exitCode;
        entry.status.signal = signal;
        entry.status.status =
          entry.stopRequested || signal === "SIGTERM" || signal === "SIGINT"
            ? "stopped"
            : exitCode === 0
              ? "exited"
              : "failed";
        entry.stopRequested = false;
      });

      return {
        started: true,
        status: cloneStatus(entry.status),
        command: commandInfo.displayCommand,
        packageManager,
        scriptName
      };
    } catch (error) {
      entry.child = null;
      entry.status = {
        ...defaultStatus(resolvedWorkdir),
        status: "failed",
        exitedAt: new Date().toISOString()
      };
      this.appendOutput(entry, `\n[spawn error] ${toErrorMessage(error)}`);
      return {
        started: false,
        reason: "spawn_error",
        error: toErrorMessage(error)
      };
    }
  }

  stop(workdir: string): boolean {
    const entry = this.ensureEntry(workdir);
    if (!entry.child || !entry.status.running) {
      return false;
    }

    entry.stopRequested = true;
    return entry.child.kill("SIGTERM");
  }

  async shutdown(): Promise<void> {
    for (const workdir of this.entries.keys()) {
      this.stop(workdir);
    }
  }
}
