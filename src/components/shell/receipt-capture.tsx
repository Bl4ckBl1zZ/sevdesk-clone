"use client";

import { NotConnectedError } from "@/components/not-connected";

/**
 * Upload of a captured receipt to the inbox (04-ui-ux §3.3, F06 receipt inbox).
 * TODO(convex): replace with the inbox upload (generateUploadUrl + inbox.createFromUpload).
 */
export async function uploadReceipt(_file: File): Promise<void> {
  throw new NotConnectedError("inbox.upload");
}
