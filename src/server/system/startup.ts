import { startupSecretProblems } from "@/domain/system/security";

/**
 * F12 AUD-021 / E-AUD-20 fail closed: in production the `web` container refuses to start without
 * `APP_ENCRYPTION_KEY` and `JWT_PRIVATE_KEY_PEM` (compose also requires them with `${VAR:?}`). Called from
 * src/instrumentation.ts at server start; `next build` and development are not affected.
 */
export function enforceStartupSecrets(
  env: Readonly<Record<string, string | undefined>>,
  io: { exit: (code: number) => void; log: (line: string) => void },
): boolean {
  if (env.NODE_ENV !== "production" || env.NEXT_PHASE === "phase-production-build") return true;
  const problems = startupSecretProblems(env);
  if (problems.length === 0) return true;
  for (const p of problems) io.log(p);
  io.exit(1);
  return false;
}
