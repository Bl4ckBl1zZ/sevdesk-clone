import "server-only";
import nextPackage from "next/package.json";
import appPackage from "../../../package.json";

/** Release date of the bundled rule tables (src/domain/rules); bump with every rule-data change (SET-120/130). */
export const RULE_TABLES_RELEASE = "2026-10-12";

export interface SystemVersions {
  app: { version: string; gitSha: string | null; buildDate: string | null };
  next: string;
  node: string;
  convexImage: string | null;
  betterAuth: string;
  ruleTables: string;
}

/** SET-130: versions shown on /einstellungen/system (web side; einvoice-tools versions come from its /health). */
export function systemVersions(env: NodeJS.ProcessEnv = process.env): SystemVersions {
  return {
    app: {
      version: env.APP_VERSION ?? appPackage.version,
      gitSha: env.GIT_SHA ?? null,
      buildDate: env.BUILD_DATE ?? null,
    },
    next: nextPackage.version,
    node: process.version,
    convexImage: env.CONVEX_SHA ?? null,
    betterAuth: appPackage.dependencies["better-auth"],
    ruleTables: RULE_TABLES_RELEASE,
  };
}
