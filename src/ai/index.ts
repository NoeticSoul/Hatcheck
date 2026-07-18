// Provider-agnostic AI adapter STUB. Real providers (anthropic, openai,
// ollama) land in Phase 3+. Charter principle: AI features are optional,
// off by default, and every AI call writes an audit record BEFORE the
// provider is invoked. Nothing in this module reaches the network.
import type { AppConfig } from "../config";
import type { Store } from "../db/store";

export interface AiStatus {
  enabled: boolean;
  provider: "anthropic" | "openai" | "ollama" | null;
}

/** Thrown when an AI feature is invoked but no provider is configured. */
export class AiNotConfiguredError extends Error {
  constructor(
    message = "No AI provider is configured; AI features are disabled",
  ) {
    super(message);
    this.name = "AiNotConfiguredError";
  }
}

/** Thrown after the audit write: provider integration is Phase 3+ work. */
export class AiNotImplementedError extends Error {
  constructor(message = "AI provider integration lands in Phase 3") {
    super(message);
    this.name = "AiNotImplementedError";
  }
}

export interface AiActor {
  userId: string | null;
  email: string | null;
}

export interface AiAdapter {
  status(): AiStatus;
  invoke(feature: string, actor: AiActor): Promise<never>;
}

export function createAiAdapter(config: AppConfig, store: Store): AiAdapter {
  return {
    status(): AiStatus {
      return { enabled: config.ai.enabled, provider: config.ai.provider };
    },

    async invoke(feature: string, actor: AiActor): Promise<never> {
      if (!config.ai.enabled) {
        // No call happened, so no audit record is written.
        throw new AiNotConfiguredError();
      }
      // Invariant: the audit record is written before any provider call
      // would be made. Phase 3 implementations must preserve this ordering.
      await store.appendAudit({
        action: "ai.call",
        actorUserId: actor.userId,
        actorEmail: actor.email,
        entityType: "ai",
        details: { feature, provider: config.ai.provider },
      });
      throw new AiNotImplementedError(
        "AI provider integration lands in Phase 3",
      );
    },
  };
}
