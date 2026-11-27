import type { HandoffMutationFence, HandoffPacket } from "./types.js";
/** Public idempotency metadata, never a credential. Keep the same value for a lost-response retry. */
export const createHandoffOperationId = (): string =>
  `hmo_${crypto.randomUUID().replaceAll("-", "")}`;
export const handoffFence = (
  packet: HandoffPacket,
  operationId = createHandoffOperationId(),
): HandoffMutationFence => ({
  expectedRevision: packet.revision ?? 0,
  expectedGeneration: packet.generation ?? 0,
  operationId,
});
