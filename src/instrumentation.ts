/** Next.js server start hook: F12 AUD-021 / E-AUD-20 — refuse to start in production without the web secrets. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { enforceStartupSecrets } = await import("./server/system/startup");
  enforceStartupSecrets(process.env, {
    exit: (code) => process.exit(code),
    log: (line) => console.error(line),
  });
}
