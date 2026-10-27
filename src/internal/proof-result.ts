import { agent, HEADER, type X401ErrorObject } from "@proof.com/x401-node";

export function proofResult(response: Response): X401ErrorObject | undefined {
  const header = response.headers.get(HEADER.PROOF_RESULT);
  return header === null ? undefined : agent.decodeErrorObject(header);
}
