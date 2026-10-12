/**
 * Vitest global setup (runs once in the main process before any project).
 * Placeholder: later used e.g. to verify the self-hosted Convex backend for the `integration` project.
 */
export default function setup() {
  // Deterministic time zone for every worker; domain code never reads the clock (`today` is passed in).
  process.env.TZ = "UTC";
}
