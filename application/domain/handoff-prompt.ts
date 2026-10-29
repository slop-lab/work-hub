import type { VerificationEnvelope } from "../contracts/handoff.ts";
import { renderPrompt } from "../prompts/index.ts";

export type VerificationPromptInput = {
  readonly task: {
    readonly id: string;
    readonly revision: number;
    readonly scopeRevision: number;
    readonly title: string;
    readonly description: string;
    readonly expectedOutcome?: string;
  };
  readonly repository: {
    readonly id: string;
    readonly projectId: string;
    readonly canonicalIdentity: string;
    readonly revision: number;
  };
  readonly verification: VerificationEnvelope;
};

export function renderVerificationPrompt(input: VerificationPromptInput): {
  readonly prompt: string;
  readonly promptDigest: string;
} {
  const rendered = renderPrompt("verifier_handoff", input);
  return { prompt: rendered.text, promptDigest: rendered.digest };
}
