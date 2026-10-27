import {
  X401AgentError,
  type DcApiRequest,
  type ResultReference,
  type X401Wallet,
} from "./fetch.ts";
import {
  call,
  failed,
  parsePresentation,
  DC_API_REQUESTS,
  sleep,
  type Presentation,
  type PresentationPending,
  type ProofOptions,
} from "./internal/proof-api.ts";

export type {
  Presentation,
  PresentationEnded,
  PresentationPending,
  PresentationReady,
  ProofOptions,
} from "./internal/proof-api.ts";

export type ProofWalletOptions = ProofOptions & {
  onApproval?: (presentation: PresentationPending) => void | Promise<void>;
};

export async function createPresentation(
  options: ProofOptions,
  request: DcApiRequest,
): Promise<PresentationPending> {
  const presentation = await parsePresentation(
    await call(options, "POST", DC_API_REQUESTS, { request }),
  );
  if (presentation.status !== "pending") {
    throw failed(
      `Proof created a presentation in state ${presentation.status}`,
    );
  }
  return presentation;
}

export function getPresentation(
  options: ProofOptions,
  id: string,
): Promise<Presentation> {
  return call(
    options,
    "GET",
    `${DC_API_REQUESTS}/${encodeURIComponent(id)}`,
  ).then(parsePresentation);
}

export async function cancelPresentation(
  options: ProofOptions,
  id: string,
): Promise<void> {
  const response = await call(
    options,
    "DELETE",
    `${DC_API_REQUESTS}/${encodeURIComponent(id)}`,
  );
  await response.body?.cancel();
}

export async function awaitPresentation(
  options: ProofOptions,
  pending: Presentation,
): Promise<ResultReference> {
  let presentation = pending;
  for (;;) {
    switch (presentation.status) {
      case "ready": {
        if (typeof presentation.credential_result_uri !== "string") {
          throw failed("Proof reported ready without a credential_result_uri");
        }
        return {
          resultUri: presentation.credential_result_uri,
          ...(typeof presentation.expires_at === "string" && {
            expiresAt: presentation.expires_at,
          }),
        };
      }
      case "expired":
        throw new X401AgentError("expired");
      case "cancelled":
        throw new X401AgentError("cancelled");
      case "pending": {
        const retryAfter = presentation.retry_after;
        if (!Number.isInteger(retryAfter) || retryAfter <= 0) {
          throw failed("Proof reported pending without a usable retry_after");
        }
        await sleep(retryAfter * 1000);
        presentation = await getPresentation(options, presentation.id);
        break;
      }
      default:
        throw failed("Proof reported an unknown presentation status");
    }
  }
}

export function proofWallet(options: ProofWalletOptions): X401Wallet {
  return {
    present: async ({ requirement }) => {
      const pending = await createPresentation(options, requirement);
      await options.onApproval?.(pending);
      return awaitPresentation(options, pending);
    },
  };
}
