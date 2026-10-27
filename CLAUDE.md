# x401-agent

The agent side of x401 (https://x401.proof.com/spec/latest/): answers a `PROOF-REQUEST` with
Proof's hosted wallet, given the user's access token.

## Rules

1. **Credential-only.** No OAuth flow, token storage or login UI; those belong to the application or
   x401-cli.
2. **Web standard only in `src/`.** No `node:*` imports.
3. **Wire format through `@proof.com/x401-node`.** Proof receives only the DC API request entry.
4. **Never leak a `PROOF-RESPONSE` or a token.** Nothing is logged; errors never carry a response
   body. The `PROOF-RESPONSE` goes only on the retry, with `redirect: "manual"`.
5. **Spec-minimal.** No checks beyond the x401 spec and Proof's OpenAPI file.
6. **Export only what a consumer calls.** Everything else goes in `src/internal/`.
7. Run `yarn check-all` before any commit or push. No `eslint-disable`, `@ts-ignore`,
   `@ts-expect-error`, or code comments. Never bump, tag or publish without explicit confirmation.

## Conventions

- `import type` / `export type` (`verbatimModuleSyntax`); optional fields by conditional spread
  (`exactOptionalPropertyTypes`); local imports end in `.ts`.
- `src/generated/proof.ts` is generated: `yarn generate <openapi-file>`. Do not edit it.
