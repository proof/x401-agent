import assert from "node:assert/strict";
import test from "node:test";
import { HEADER, verifier } from "@proof.com/x401-node";
import {
  encodeProofResponse,
  requirementOf,
  withX401Fetch,
  X401AgentError,
  type ResultReference,
  type X401AgentErrorCode,
  type X401Wallet,
} from "../src/index.ts";
import {
  base64url,
  ENTRY,
  PROOF_REQUEST,
  proofRequestWith,
  recordingFetch,
} from "./helpers.ts";

const RESULT: ResultReference = {
  resultUri: "https://proof.example/dc-api/results/secret",
  expiresAt: "2026-10-22T10:05:00Z",
};
const PROOF = encodeProofResponse(RESULT);
const URL_ = "https://verifier.example/protected";

const challenge = (status = 401) =>
  new Response("challenge body", {
    status,
    headers: { [HEADER.PROOF_REQUEST]: PROOF_REQUEST },
  });

const rejection = (error: string, status = 401) =>
  new Response(null, {
    status,
    headers: {
      [HEADER.PROOF_RESULT]: base64url({
        scheme: "x401",
        version: "0.2.0",
        error,
      }),
    },
  });

function recordingWallet() {
  const calls: Parameters<X401Wallet["present"]>[0][] = [];
  const presenter: X401Wallet = {
    present: async (request) => {
      calls.push(request);
      return RESULT;
    },
  };
  return { presenter, calls };
}

test("requirementOf returns the single DC API request entry and refuses anything else", () => {
  assert.deepEqual(requirementOf(PROOF_REQUEST), ENTRY);
  for (const proofRequest of [
    "not-base64url!",
    proofRequestWith(ENTRY, ENTRY),
  ]) {
    assert.throws(
      () => requirementOf(proofRequest),
      isAgentError("invalid_proof_request"),
    );
  }
});

test("encodeProofResponse builds a by-reference Result Artifact", () => {
  assert.deepEqual(verifier.decodeResultArtifact(PROOF), {
    credential_result_uri: RESULT.resultUri,
    expires_at: RESULT.expiresAt,
  });
});

const isAgentError =
  (code: X401AgentErrorCode) =>
  (error: unknown): boolean =>
    error instanceof X401AgentError && error.code === code;

test("a response without PROOF-REQUEST passes through without presenting", async () => {
  const { fetch, requests } = recordingFetch(new Response("ok"));
  const { presenter, calls } = recordingWallet();

  const response = await withX401Fetch(fetch, presenter)(URL_);

  assert.equal(await response.text(), "ok");
  assert.equal(requests.length, 1);
  assert.equal(calls.length, 0);
});

test("a 2xx response that advertises PROOF-REQUEST is returned untouched", async () => {
  const { fetch, requests } = recordingFetch(challenge(200));
  const { presenter, calls } = recordingWallet();

  const response = await withX401Fetch(fetch, presenter)(URL_);

  assert.equal(response.status, 200);
  assert.equal(requests.length, 1);
  assert.equal(calls.length, 0);
});

test("a 402 that carries PROOF-REQUEST is left to the payment layer", async () => {
  const { fetch, requests } = recordingFetch(challenge(402));
  const { presenter, calls } = recordingWallet();

  const response = await withX401Fetch(fetch, presenter)(URL_);

  assert.equal(response.status, 402);
  assert.equal(response.headers.get(HEADER.PROOF_REQUEST), PROOF_REQUEST);
  assert.equal(requests.length, 1);
  assert.equal(calls.length, 0);
});

test("a 401 challenge is presented and the same request is retried once with PROOF-RESPONSE", async () => {
  const { fetch, requests } = recordingFetch(
    challenge(),
    new Response("granted"),
  );
  const { presenter, calls } = recordingWallet();

  const response = await withX401Fetch(fetch, presenter)(
    "https://verifier.example:443/protected",
    {
      method: "POST",
      body: "payload",
      headers: { Authorization: "Bearer app" },
    },
  );

  assert.equal(await response.text(), "granted");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.requirement, ENTRY);
  assert.equal(calls[0]!.origin, "https://verifier.example");
  const retry = requests[1]!;
  assert.equal(requests.length, 2);
  assert.equal(retry.method, "POST");
  assert.equal(retry.url, URL_);
  assert.equal(retry.body, "payload");
  assert.equal(retry.headers.get("authorization"), "Bearer app");
  assert.equal(retry.headers.get(HEADER.PROOF_RESPONSE), PROOF);
});

test("the retry does not follow redirects", async () => {
  let redirectMode: RequestRedirect | undefined;
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.headers.has(HEADER.PROOF_RESPONSE)) {
      redirectMode = request.redirect;
      return new Response(null, {
        status: 307,
        headers: { Location: "https://elsewhere.example/" },
      });
    }
    return challenge();
  };

  const response = await withX401Fetch(
    fetch,
    recordingWallet().presenter,
  )(URL_);

  assert.equal(response.status, 307);
  assert.equal(redirectMode, "manual");
});

test("a malformed PROOF-REQUEST is refused without presenting", async () => {
  const { fetch } = recordingFetch(
    new Response(null, {
      status: 401,
      headers: { [HEADER.PROOF_REQUEST]: "not-base64url!" },
    }),
  );
  const { presenter, calls } = recordingWallet();

  await assert.rejects(
    withX401Fetch(fetch, presenter)(URL_),
    isAgentError("invalid_proof_request"),
  );
  assert.equal(calls.length, 0);
});

test("a PROOF-RESULT on the retry rejects with the verifier's error object at any status", async () => {
  for (const status of [401, 200]) {
    const { fetch } = recordingFetch(
      challenge(),
      rejection("invalid_nonce", status),
    );

    await assert.rejects(
      withX401Fetch(fetch, recordingWallet().presenter)(URL_),
      (error: unknown) =>
        isAgentError("proof_rejected")(error) &&
        (error as X401AgentError).result?.error === "invalid_nonce" &&
        !String(error).includes(PROOF),
    );
  }
});

test("a fresh PROOF-REQUEST on the retry is returned without another attempt", async () => {
  const { fetch, requests } = recordingFetch(challenge(), challenge());

  const response = await withX401Fetch(
    fetch,
    recordingWallet().presenter,
  )(URL_);

  assert.equal(response.status, 401);
  assert.equal(requests.length, 2);
});

test("a 401 challenge reached through a redirect is presented", async () => {
  const redirected = challenge();
  Object.defineProperty(redirected, "redirected", { value: true });
  const { fetch } = recordingFetch(redirected, new Response("granted"));
  const { presenter, calls } = recordingWallet();

  const response = await withX401Fetch(fetch, presenter)(URL_);

  assert.equal(await response.text(), "granted");
  assert.equal(calls.length, 1);
});

test("a wallet failure rejects without retrying", async () => {
  const { fetch, requests } = recordingFetch(challenge());
  const wallet: X401Wallet = {
    present: async () => {
      throw new Error("stop");
    },
  };

  await assert.rejects(withX401Fetch(fetch, wallet)(URL_), /stop/);
  assert.equal(requests.length, 1);
});
