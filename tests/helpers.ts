import {
  verifier,
  type DigitalCredentialRequestEntry,
} from "@proof.com/x401-node";

export const ENTRY: DigitalCredentialRequestEntry = {
  protocol: "openid4vp-v1-signed",
  data: { request: "header.payload.signature" },
};

export const proofRequestWith = (
  ...requests: DigitalCredentialRequestEntry[]
): string =>
  verifier.encodePayload(
    verifier.buildPayload({
      credentialRequirements: { digital: { requests } },
    }),
  );

export const PROOF_REQUEST = proofRequestWith(ENTRY);

export const base64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

export type RecordedRequest = {
  method: string;
  url: string;
  headers: Headers;
  body: string;
};

export function recordingFetch(...responses: Response[]) {
  const requests: RecordedRequest[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: await request.text(),
    });
    return responses.shift() ?? new Response("unexpected", { status: 500 });
  };
  return { fetch, requests };
}

export const settle = async () => {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};
