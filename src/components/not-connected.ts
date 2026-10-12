/**
 * Marker for UI adapters whose backend (Convex functions, auth plugins) does not exist yet. Callers show the
 * toast "Noch nicht verbunden" — nothing pretends to be saved.
 */
export class NotConnectedError extends Error {
  constructor(public readonly operation: string) {
    super(`Noch nicht verbunden: ${operation}`);
    this.name = "NotConnectedError";
  }
}

export function isNotConnected(error: unknown): error is NotConnectedError {
  return error instanceof NotConnectedError;
}
