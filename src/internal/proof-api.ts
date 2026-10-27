import type { Environment } from "@proof.com/proof-vc-common";
import { resolveBaseUrl } from "@proof.com/proof-vc-common/internal";
import { X401AgentError } from "../fetch.ts";
import type { components } from "../generated/proof.ts";

type Schemas = components["schemas"];

export type PresentationPending = Schemas["PresentationPending"];
export type PresentationReady = Schemas["PresentationReady"];
export type PresentationEnded = Schemas["PresentationEnded"];
export type Presentation =
  PresentationPending | PresentationReady | PresentationEnded;

export type ProofOptions = {
  environment: Environment | { baseUrl: string };
  accessToken: string | (() => string | Promise<string>);
  fetch?: typeof globalThis.fetch;
};

export const DC_API_REQUESTS = "/verifiable-credentials/v1/dc-api/requests";
const STATUSES = new Set(["pending", "ready", "expired", "cancelled"]);
const REQUEST_TIMEOUT_MS = 30_000;

export const failed = (detail: string) =>
  new X401AgentError("presentation_failed", { detail });

function baseUrl(options: ProofOptions): string {
  const url =
    typeof options.environment === "string"
      ? resolveBaseUrl(options.environment)
      : options.environment.baseUrl;
  return url.replace(/\/+$/, "");
}

async function bearer(options: ProofOptions): Promise<string> {
  const token =
    typeof options.accessToken === "function"
      ? await options.accessToken()
      : options.accessToken;
  return `Bearer ${token}`;
}

export async function call(
  options: ProofOptions,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const fetch = options.fetch ?? globalThis.fetch;
  const headers = new Headers({
    Authorization: await bearer(options),
    Accept: "application/json",
  });
  if (body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`${baseUrl(options)}${path}`, {
    method,
    headers,
    ...(body !== undefined && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 401) {
    await response.body?.cancel();
    throw new X401AgentError("unauthorized");
  }
  if (response.status === 429) {
    await response.body?.cancel();
    const retryAfter = Number(response.headers.get("Retry-After"));
    throw new X401AgentError("rate_limited", {
      ...(Number.isInteger(retryAfter) && retryAfter > 0 && { retryAfter }),
    });
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw failed(`Proof answered ${response.status} on ${method} ${path}`);
  }
  return response;
}

export async function parsePresentation(
  response: Response,
): Promise<Presentation> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw failed("Proof returned a presentation that is not JSON");
  }
  if (
    typeof body !== "object" ||
    body === null ||
    !("id" in body) ||
    typeof body.id !== "string" ||
    !("status" in body) ||
    typeof body.status !== "string" ||
    !STATUSES.has(body.status)
  ) {
    throw failed("Proof returned a presentation without a known id and status");
  }
  return body as Presentation;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
