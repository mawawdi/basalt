import type { ReferenceImageReceipt } from "./receipt.js";
import type { ReferenceImageRequest } from "./request.js";

/** Provider implementations are one-turn transports and never enter world contracts. */
export interface ReferenceImageAdapter {
  readonly adapterId: string;
  generate(request: ReferenceImageRequest, signal?: AbortSignal): Promise<ReferenceImageReceipt>;
}

export async function executeReferenceImageRequest(input: {
  readonly adapter: ReferenceImageAdapter;
  readonly request: ReferenceImageRequest;
  readonly signal?: AbortSignal;
}): Promise<ReferenceImageReceipt> {
  const receipt = await input.adapter.generate(input.request, input.signal);
  if (receipt.adapterId !== input.adapter.adapterId)
    throw new Error("Reference-image receipt names a different adapter");
  if (receipt.requestHash !== input.request.requestHash)
    throw new Error("Reference-image receipt binds a different request");
  return receipt;
}
