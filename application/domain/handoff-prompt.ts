import { digest } from "../persistence/codec.ts";
import type { VerificationEnvelope } from "../contracts/handoff.ts";

export const recipientIntegrationPrompt = {
  assignmentTool: "workhub_assignment",
  acknowledgmentTool: "workhub_ack",
  resultTool: "workhub_result",
  assignmentReadRequired: true,
  deliveryAcknowledgmentRequired: true,
  humanAcceptanceSeparate: true,
} as const;

export type VerificationPromptInput = {
  readonly task: {
    readonly id: string;
    readonly revision: number;
    readonly title: string;
    readonly description: string;
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
  const prompt = JSON.stringify({
    contract: "workhub.verification-handoff.v1",
    task: input.task,
    repository: input.repository,
    verification: input.verification,
    recipientIntegration: recipientIntegrationPrompt,
  });
  return { prompt, promptDigest: digest(prompt) };
}
