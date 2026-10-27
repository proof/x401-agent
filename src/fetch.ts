import { agent, HEADER, type X401ErrorObject } from "@proof.com/x401-node";
import { proofResult } from "./internal/proof-result.ts";

export type DcApiRequest = {
  protocol: string;
  data: unknown;
};

export type ResultReference = {
  resultUri: string;
  expiresAt?: string;
};

export type X401Wallet = {
  present(request: {
    requirement: DcApiRequest;
    origin: string;
  }): Promise<ResultReference>;
};

export type X401AgentErrorCode =
  | "invalid_proof_request"
  | "proof_rejected"
  | "expired"
  | "cancelled"
  | "presentation_failed"
  | "unauthorized"
  | "rate_limited";

const ERROR_DESCRIPTION: Record<X401AgentErrorCode, string> = {
  invalid_proof_request: "PROOF-REQUEST is not a valid x401 proof requirement",
  proof_rejected: "The verifier rejected the presented proof",
  expired: "The presentation expired",
  cancelled: "The presentation was cancelled",
  presentation_failed: "The presentation could not be obtained",
  unauthorized: "Proof rejected the access token",
  rate_limited: "Proof rate-limited the presentation requests",
};

export class X401AgentError extends Error {
  readonly code: X401AgentErrorCode;
  readonly result?: X401ErrorObject;
  readonly retryAfter?: number;

  constructor(
    code: X401AgentErrorCode,
    options?: {
      cause?: unknown;
      result?: X401ErrorObject;
      retryAfter?: number;
      detail?: string;
    },
  ) {
    super(
      options?.detail === undefined
        ? ERROR_DESCRIPTION[code]
        : `${ERROR_DESCRIPTION[code]}: ${options.detail}`,
      options,
    );
    this.code = code;
    if (options?.result !== undefined) {
      this.result = options.result;
    }
    if (options?.retryAfter !== undefined) {
      this.retryAfter = options.retryAfter;
    }
  }
}

export function requirementOf(proofRequest: string): DcApiRequest {
  try {
    const { requests } = agent.getDigitalCredentialRequest(
      agent.decodePayload(proofRequest),
    );
    const [entry] = requests;
    if (requests.length !== 1 || entry === undefined) {
      throw new Error("exactly one Digital Credentials request is supported");
    }
    return entry;
  } catch (cause) {
    throw new X401AgentError("invalid_proof_request", { cause });
  }
}

export function encodeProofResponse(result: ResultReference): string {
  return agent.encodeResultArtifact(
    agent.buildResultArtifactReference({
      credentialResultUri: result.resultUri,
      ...(result.expiresAt !== undefined && { expiresAt: result.expiresAt }),
    }),
  );
}

export async function retryWithProofResponse(
  fetch: typeof globalThis.fetch,
  request: Request,
  result: ResultReference,
): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.set(HEADER.PROOF_RESPONSE, encodeProofResponse(result));
  const retried = await fetch(
    new Request(request, { headers, redirect: "manual" }),
  );
  const rejection = proofResult(retried);
  if (rejection !== undefined) {
    await retried.body?.cancel();
    throw new X401AgentError("proof_rejected", { result: rejection });
  }
  return retried;
}

export function withX401Fetch(
  fetch: typeof globalThis.fetch,
  wallet: X401Wallet,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const request = new Request(input, init);
    const replay = request.clone();
    const response = await fetch(request);
    const proofRequest = response.headers.get(HEADER.PROOF_REQUEST);
    if (response.status !== 401 || proofRequest === null) {
      await replay.body?.cancel();
      return response;
    }
    let requirement: DcApiRequest;
    try {
      requirement = requirementOf(proofRequest);
    } catch (error) {
      await replay.body?.cancel();
      throw error;
    }
    await response.body?.cancel();

    const result = await wallet.present({
      requirement,
      origin: new URL(request.url).origin,
    });
    return retryWithProofResponse(fetch, replay, result);
  };
}
