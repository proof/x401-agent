# x401-agent

x401-agent lets your agent call endpoints that require proof of identity.

When an endpoint answers with an [x401](https://x401.proof.com/spec/latest/) proof request, the user
presents their credential from their Proof Cloud Wallet, and the agent retries the request with the
presented credential.

From a shell, use [x401-cli](https://github.com/proof/x401-cli) instead.

- [Installation](#installation)
- [Quickstart](#quickstart)
- [Usage](#usage)
  - [Show the approval link](#show-the-approval-link)
  - [Resume a pending request](#resume-a-pending-request)
  - [Handle errors](#handle-errors)
- [Configuration](#configuration)
- [Errors](#errors)
- [Links](#links)
- [License](#license)

## Installation

```sh
npm install @proof.com/x401-agent
```

## Quickstart

Get a Proof access token and export it in the agent's environment:

```sh
export PROOF_ACCESS_TOKEN=$(npx @proof.com/x401-cli token --sandbox)
```

Request the sandbox test endpoint through `withX401Fetch`:

```js
import { proofWallet, withX401Fetch } from "@proof.com/x401-agent";

const wallet = proofWallet({
  environment: "sandbox",
  accessToken: process.env.PROOF_ACCESS_TOKEN,
});

const fetchWithProof = withX401Fetch(fetch, wallet);
const response = await fetchWithProof(
  "https://try.proof.com/x401/protected?env=fairfax",
);
console.log(response.status);
// => 200
```

Proof emails the user an approval link. `fetchWithProof` waits for the approval, retries the
request with the proof, and the endpoint answers `200`.

## Usage

### Show the approval link

`onApproval` receives the pending request. `notification.channel` indicates where Proof sent the
approval link to the user; when it is `none`, show `approval_uri` to the user.

```js
import { proofWallet, withX401Fetch } from "@proof.com/x401-agent";

const wallet = proofWallet({
  environment: "sandbox",
  accessToken: process.env.PROOF_ACCESS_TOKEN,
  onApproval: ({ approval_uri, notification }) => {
    if (notification.channel === "none") {
      console.log(`Approve the request: ${approval_uri}`);
    } else {
      console.log(`Proof sent an approval link by ${notification.channel}`);
    }
  },
});

await withX401Fetch(
  fetch,
  wallet,
)("https://try.proof.com/x401/protected?env=fairfax");
```

### Resume a pending request

Keep `pending.id` to pick the request up with `getPresentation`.

```js
import {
  awaitPresentation,
  createPresentation,
  getPresentation,
  requirementOf,
  retryWithProofResponse,
} from "@proof.com/x401-agent";

const options = {
  environment: "sandbox",
  accessToken: process.env.PROOF_ACCESS_TOKEN,
};
const url = "https://try.proof.com/x401/protected?env=fairfax";

const challenge = await fetch(url);
const pending = await createPresentation(
  options,
  requirementOf(challenge.headers.get("PROOF-REQUEST")),
);

const presentation = await getPresentation(options, pending.id);
const result = await awaitPresentation(options, presentation);
const response = await retryWithProofResponse(fetch, new Request(url), result);
console.log(response.status);
// => 200
```

### Handle errors

```js
import {
  proofWallet,
  withX401Fetch,
  X401AgentError,
} from "@proof.com/x401-agent";

const fetchWithProof = withX401Fetch(
  fetch,
  proofWallet({
    environment: "sandbox",
    accessToken: process.env.PROOF_ACCESS_TOKEN,
  }),
);

try {
  await fetchWithProof("https://try.proof.com/x401/protected?env=fairfax");
} catch (error) {
  if (error instanceof X401AgentError && error.code === "proof_rejected") {
    console.log("The endpoint rejected the proof:", error.result);
  } else {
    throw error;
  }
}
```

## Configuration

`environment` is `"sandbox"` or `"production"`.

```js
proofWallet({
  environment: "production",
  accessToken: process.env.PROOF_ACCESS_TOKEN,
});
```

`fetch` replaces the global `fetch` for calls to Proof.

```js
proofWallet({
  environment: "sandbox",
  accessToken: process.env.PROOF_ACCESS_TOKEN,
  fetch: myFetch,
});
```

## Errors

| `code`                  | Meaning                                                          | What to do                            |
| ----------------------- | ---------------------------------------------------------------- | ------------------------------------- |
| `invalid_proof_request` | The endpoint's `PROOF-REQUEST` is not a single valid request     | Report it to the endpoint's owner     |
| `proof_rejected`        | The endpoint rejected the proof; `error.result` holds its reason | Start again with a new request        |
| `unauthorized`          | Proof refused the access token                                   | Refresh the token or sign the user in |
| `rate_limited`          | Too many requests; `error.retryAfter`, when set, is in seconds   | Wait before retrying                  |
| `presentation_failed`   | Proof answered with an error status or an unexpected body        | Check `error.message`, then retry     |

## Links

- [Read the x401 specification](https://x401.proof.com/spec/latest/)
- [Answer proof requests from a shell with x401-cli](https://github.com/proof/x401-cli)
- [Use x401 for your Cloudflare Worker endpoints](https://github.com/proof/x401-workers)

## License

[Apache-2.0](LICENSE)
