import { t, type Locale } from "../bot/i18n.js";
import type { CodexSmithAccessState } from "../bot/accessContext.js";
import { relativeInside } from "../lib/paths.js";
import type { Capability } from "./capabilities.js";
import { isRepoAllowed, type AccessGrant } from "./policy.js";

export interface GuardContext {
  state?: {
    codexSmith?: CodexSmithAccessState;
  };
  reply: (text: string, extra?: Record<string, unknown>) => Promise<unknown>;
}

export interface WorkdirTarget {
  workspaceRoot: string;
  workdir: string;
  relativeWorkdir: string;
}

// Enforces capabilities per handler. A context without a resolved grant is
// always denied, so a handler that skips the middleware fails closed.
export class AccessGuard {
  private readonly lastNotice = new Map<string, number>();
  private readonly now: () => number;

  constructor({ now = Date.now }: { now?: () => number } = {}) {
    this.now = now;
  }

  grantOf(ctx: GuardContext): AccessGrant | undefined {
    return ctx.state?.codexSmith?.grant;
  }

  can(ctx: GuardContext, capability: Capability): boolean {
    return Boolean(this.grantOf(ctx)?.capabilities.includes(capability));
  }

  async require(
    ctx: GuardContext,
    capability: Capability,
    locale: Locale
  ): Promise<boolean> {
    const access = ctx.state?.codexSmith;
    const grant = access?.grant;
    const allowed = this.can(ctx, capability);
    this.audit(access, capability, allowed);
    if (allowed) return true;

    if (
      access &&
      grant?.denyFeedback === "notice" &&
      this.shouldNotify(access.conversationKey, grant.cooldownSeconds)
    ) {
      await ctx
        .reply(t(locale, "accessDenied", { capability, role: grant.roleLabel }))
        .catch(() => {});
    }
    return false;
  }

  isWorkdirAllowed(
    ctx: GuardContext,
    workspaceRoot: string,
    workdir: string
  ): boolean {
    const grant = this.grantOf(ctx);
    if (!grant) return false;
    return isRepoAllowed(grant, relativeInside(workspaceRoot, workdir));
  }

  async requireWorkdir(
    ctx: GuardContext,
    target: WorkdirTarget,
    locale: Locale
  ): Promise<boolean> {
    if (this.isWorkdirAllowed(ctx, target.workspaceRoot, target.workdir)) {
      return true;
    }

    this.audit(ctx.state?.codexSmith, `repo:${target.relativeWorkdir}`, false);
    await ctx
      .reply(
        t(locale, "accessWorkdirDenied", {
          relativeWorkdir: target.relativeWorkdir
        })
      )
      .catch(() => {});
    return false;
  }

  private shouldNotify(key: string, cooldownSeconds: number): boolean {
    const now = this.now();
    const last = this.lastNotice.get(key);
    if (last !== undefined && now - last < cooldownSeconds * 1000) {
      return false;
    }
    this.lastNotice.set(key, now);
    return true;
  }

  private audit(
    access: CodexSmithAccessState | undefined,
    subject: string,
    allowed: boolean
  ): void {
    const level = access?.grant?.audit ?? "denied";
    if (level === "off" || (allowed && level !== "all")) return;
    console.info(
      `[access] ${allowed ? "allow" : "deny"} user=${access?.userId || "?"} chat=${access?.chatId || "?"} role=${access?.grant?.role || "none"} ${subject}`
    );
  }
}
