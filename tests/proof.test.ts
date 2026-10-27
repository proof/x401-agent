import assert from "node:assert/strict";
import test from "node:test";
import { HEADER, verifier } from "@proof.com/x401-node";
import {
  awaitPresentation,
  cancelPresentation,
  createPresentation,
  getPresentation,
  proofWallet,
  withX401Fetch,
  X401AgentError,
  type PresentationPending,
  type ProofOptions,
  type X401AgentErrorCode,
} from "../src/index.ts";
import { ENTRY, PROOF_REQUEST, recordingFetch, settle } from "./helpers.ts";

const API = "https://api.fairfax.proof.com/verifiable-credentials/v1";
const RESULT_URI = `${API}/dc-api/results/4f8c`;
const SECRET = "SECRET-BODY";

const PENDING = {
  id: "ot1",
  status: "pending",
  approval_uri: "https://proof.example/approve/ot1",
  notification: { channel: "sms", destination_hint: "••• •• 34" },
  retry_after: 15,
  expires_at: "2026-10-22T10:15:00Z",
};
const READY = {
  id: "ot1",
  status: "ready",
  credential_result_uri: RESULT_URI,
  expires_at: "2026-10-22T10:05:00Z",
};
const ended = (status: string) => ({ id: "ot1", status });

const json = (body: unknown, status = 200) => Response.json(body, { status });

const isAgentError =
  (code: X401AgentErrorCode) =>
  (error: unknown): boolean =>
    error instanceof X401AgentError && error.code === code;

const assertNoSecret = (error: unknown) => {
  const agentError = error as X401AgentError;
  for (const value of [
    String(agentError),
    agentError.message,
    String(agentError.cause),
  ]) {
    assert.equal(value.includes(SECRET), false);
  }
};

function proofApi(...responses: Response[]) {
  const { fetch, requests } = recordingFetch(...responses);
  let tokens = 0;
  const options: ProofOptions = {
    environment: "sandbox",
    accessToken: async () => `token-${++tokens}`,
    fetch,
  };
  return { options, requests, tokenCalls: () => tokens };
}

function present(options: ProofOptions) {
  const approvals: PresentationPending[] = [];
  const result = proofWallet({
    ...options,
    onApproval: (presentation) => {
      approvals.push(presentation);
    },
  }).present({
    requirement: ENTRY,
    origin: "https://verifier.example",
  });
  result.catch(() => undefined);
  return { result, approvals };
}

test("createPresentation posts the single DC API request entry with the bearer token", async () => {
  const { options, requests } = proofApi(json(PENDING, 201));

  const pending = await createPresentation(options, ENTRY);

  assert.deepEqual(pending, PENDING);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.method, "POST");
  assert.equal(requests[0]!.url, `${API}/dc-api/requests`);
  assert.equal(requests[0]!.headers.get("authorization"), "Bearer token-1");
  assert.equal(requests[0]!.headers.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(requests[0]!.body), { request: ENTRY });
});

test("the wallet waits for approval, polls at the server's cadence, and returns the result reference", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { options, requests, tokenCalls } = proofApi(
    json(PENDING, 201),
    json(PENDING),
    json(READY),
  );
  const { result, approvals } = present(options);

  await settle();
  assert.equal(requests.length, 1);
  assert.deepEqual(approvals, [PENDING]);
  t.mock.timers.tick(14_999);
  await settle();
  assert.equal(requests.length, 1);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(requests.length, 2);
  t.mock.timers.tick(15_000);

  const reference = await result;
  assert.equal(requests.length, 3);
  assert.equal(requests[1]!.method, "GET");
  assert.equal(requests[1]!.url, `${API}/dc-api/requests/ot1`);
  assert.equal(requests[2]!.headers.get("authorization"), "Bearer token-3");
  assert.equal(tokenCalls(), 3);
  assert.deepEqual(reference, {
    resultUri: RESULT_URI,
    expiresAt: READY.expires_at,
  });
});

test("expired and cancelled presentations reject with their own codes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const status of ["expired", "cancelled"] as const) {
    const { options } = proofApi(json(PENDING, 201), json(ended(status)));
    const { result } = present(options);
    await settle();
    t.mock.timers.tick(15_000);
    await assert.rejects(result, isAgentError(status));
  }
});

test("a 401 from Proof rejects with unauthorized", async () => {
  const { options } = proofApi(
    json({ error: "invalid_token", error_description: SECRET }, 401),
  );

  await assert.rejects(createPresentation(options, ENTRY), (error: unknown) => {
    assertNoSecret(error);
    return isAgentError("unauthorized")(error);
  });
});

test("a 429 from Proof rejects with rate_limited and the Retry-After seconds", async () => {
  const { options } = proofApi(
    new Response(SECRET, {
      status: 429,
      headers: { "Retry-After": "1800" },
    }),
  );

  await assert.rejects(createPresentation(options, ENTRY), (error: unknown) => {
    assertNoSecret(error);
    return (
      isAgentError("rate_limited")(error) &&
      (error as X401AgentError).retryAfter === 1800
    );
  });
});

test("a failed Proof call names the status and the endpoint, never the body", async () => {
  const { options } = proofApi(new Response(SECRET, { status: 404 }));

  await assert.rejects(createPresentation(options, ENTRY), (error: unknown) => {
    assertNoSecret(error);
    return (
      isAgentError("presentation_failed")(error) &&
      (error as Error).message.endsWith(
        "Proof answered 404 on POST /verifiable-credentials/v1/dc-api/requests",
      )
    );
  });
});

test("server errors and malformed views reject with presentation_failed without leaking the body", async () => {
  for (const response of [
    new Response(SECRET, { status: 500 }),
    new Response(SECRET, { status: 201 }),
    json({ id: "ot1", status: "unknown", note: SECRET }, 201),
    json({ status: "pending" }, 201),
    json(ended("declined"), 201),
    json(ended("expired"), 201),
  ]) {
    const { options } = proofApi(response);
    await assert.rejects(
      createPresentation(options, ENTRY),
      (error: unknown) => {
        assertNoSecret(error);
        return isAgentError("presentation_failed")(error);
      },
    );
  }
});

test("a pending view without a usable retry_after, or a ready view without a result URL, fails", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const views of [
    [{ ...PENDING, retry_after: 0 }],
    [PENDING, { id: "ot1", status: "ready" }],
  ]) {
    const { options } = proofApi(
      json(views[0], 201),
      ...views.slice(1).map((view) => json(view)),
    );
    const { result } = present(options);
    await settle();
    t.mock.timers.tick(15_000);
    await assert.rejects(result, isAgentError("presentation_failed"));
  }
});

test("every Proof call carries a timeout signal", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const seen: (AbortSignal | undefined)[] = [];
  const { options } = proofApi(json(PENDING, 201), json(READY));
  const fetch = options.fetch!;
  options.fetch = (input, init) => {
    seen.push(init?.signal ?? undefined);
    return fetch(input, init);
  };
  const pending = await createPresentation(options, ENTRY);
  const waiting = awaitPresentation(options, pending);
  await settle();
  t.mock.timers.tick(15_000);
  await waiting;

  assert.equal(seen.length, 2);
  assert.ok(seen.every((signal) => signal instanceof AbortSignal));
});

test("getPresentation and cancelPresentation address the presentation by id", async () => {
  const { options, requests } = proofApi(
    json(READY),
    new Response(null, { status: 204 }),
  );

  assert.deepEqual(await getPresentation(options, "ot 1"), READY);
  await cancelPresentation(options, "ot 1");

  assert.equal(requests[0]!.method, "GET");
  assert.equal(requests[0]!.url, `${API}/dc-api/requests/ot%201`);
  assert.equal(requests[1]!.method, "DELETE");
  assert.equal(requests[1]!.url, `${API}/dc-api/requests/ot%201`);
});

test("a custom baseUrl replaces the environment", async () => {
  const { options, requests } = proofApi(json(READY));
  options.environment = { baseUrl: "https://api.next.proof.com/" };

  await getPresentation(options, "ot1");

  assert.equal(
    requests[0]!.url,
    "https://api.next.proof.com/verifiable-credentials/v1/dc-api/requests/ot1",
  );
});

test("withX401Fetch with proofWallet retries the challenged request with the Result Artifact", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const site = recordingFetch(
    new Response(null, {
      status: 401,
      headers: { [HEADER.PROOF_REQUEST]: PROOF_REQUEST },
    }),
    new Response("granted"),
  );
  const { options } = proofApi(json(PENDING, 201), json(READY));
  const fetching = withX401Fetch(
    site.fetch,
    proofWallet(options),
  )("https://verifier.example/protected");
  fetching.catch(() => undefined);

  await settle();
  t.mock.timers.tick(15_000);

  const response = await fetching;
  assert.equal(await response.text(), "granted");
  const proofResponse = site.requests[1]!.headers.get(HEADER.PROOF_RESPONSE)!;
  assert.equal(
    verifier.decodeResultArtifact(proofResponse).credential_result_uri,
    RESULT_URI,
  );
});
