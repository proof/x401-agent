export {
  encodeProofResponse,
  requirementOf,
  retryWithProofResponse,
  withX401Fetch,
  X401AgentError,
} from "./fetch.ts";
export type {
  DcApiRequest,
  ResultReference,
  X401AgentErrorCode,
  X401Wallet,
} from "./fetch.ts";
export {
  awaitPresentation,
  cancelPresentation,
  createPresentation,
  getPresentation,
  proofWallet,
} from "./proof.ts";
export type {
  Presentation,
  PresentationEnded,
  PresentationPending,
  PresentationReady,
  ProofOptions,
  ProofWalletOptions,
} from "./proof.ts";
