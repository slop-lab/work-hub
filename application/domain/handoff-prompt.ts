import { renderPrompt } from "../prompts/index.ts";
import type { VerifierHandoffInput } from "../prompts/types.ts";

export type VerificationPromptInput = VerifierHandoffInput;

export function renderVerificationPrompt(input: VerificationPromptInput): {
  readonly prompt: string;
  readonly promptDigest: string;
} {
  const rendered = renderPrompt("verifier_handoff", input);
  return { prompt: rendered.text, promptDigest: rendered.digest };
}
