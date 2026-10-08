export const CAPABILITIES = [
  "bot.status",
  "bot.preferences",
  "bot.restart",
  "bot.cron",
  "repo.list",
  "repo.switch",
  "codex.prompt",
  "codex.plan",
  "codex.exec",
  "codex.auto",
  "codex.model",
  "memory.use",
  "shell.run",
  "shell.confirm",
  "dev.read",
  "dev.run",
  "gh.read",
  "gh.test",
  "gh.write",
  "mcp.read",
  "mcp.call",
  "mcp.manage",
  "skills.manage",
  "access.manage"
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export const CAPABILITY_NAMESPACES = [
  ...new Set(CAPABILITIES.map((capability) => capability.split(".")[0]))
];

export const CAPABILITY_COMMANDS: Record<Capability, string> = {
  "bot.status": "/start /help /status /pwd /whoami",
  "bot.preferences": "/language /verbose",
  "bot.restart": "/restart",
  "bot.cron": "/cron_now",
  "repo.list": "/repo (list, recent)",
  "repo.switch": "/repo <name>, /repo -",
  "codex.prompt": "plain text, /new /continue /interrupt /stop",
  "codex.plan": "/plan",
  "codex.exec": "/exec",
  "codex.auto": "/auto",
  "codex.model": "/model <name|reset>",
  "memory.use": "/memory",
  "shell.run": "/sh",
  "shell.confirm": "/sh --confirm",
  "dev.read": "/dev status|logs|url",
  "dev.run": "/dev start|stop",
  "gh.read": "/gh help|status, test status button",
  "gh.test": "/gh run tests",
  "gh.write": "/gh commit|push|create repo, /gh confirm",
  "mcp.read": "/mcp list|status|tools",
  "mcp.call": "/mcp call",
  "mcp.manage": "/mcp enable|disable|reconnect",
  "skills.manage": "/skill on|off",
  "access.manage": "/access"
};

// Maps legacy ADMIN_ONLY_COMMANDS entries to the capabilities they used to gate.
export const LEGACY_COMMAND_CAPABILITIES: Record<string, Capability[]> = {
  restart: ["bot.restart"],
  cron_now: ["bot.cron"],
  auto: ["codex.auto"],
  exec: ["codex.exec"],
  plan: ["codex.plan"],
  model: ["codex.model"],
  memory: ["memory.use"],
  repo: ["repo.switch"],
  sh: ["shell.run", "shell.confirm"],
  dev: ["dev.read", "dev.run"],
  gh: ["gh.read", "gh.test", "gh.write"],
  mcp: ["mcp.read", "mcp.call", "mcp.manage"],
  skill: ["skills.manage"],
  language: ["bot.preferences"],
  verbose: ["bot.preferences"],
  access: ["access.manage"]
};

export function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}

export function isValidCapabilityPattern(pattern: string): boolean {
  const body = pattern.startsWith("!") ? pattern.slice(1) : pattern;
  if (body === "*") return true;
  if (body.endsWith(".*")) {
    return CAPABILITY_NAMESPACES.includes(body.slice(0, -2));
  }
  return isCapability(body);
}

export function matchesCapabilityPattern(
  pattern: string,
  capability: Capability
): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) {
    return capability.startsWith(pattern.slice(0, -1));
  }
  return pattern === capability;
}
