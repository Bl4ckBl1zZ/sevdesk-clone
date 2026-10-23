/// <reference types="vite/client" />
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { symmetricEncrypt } from "better-auth/crypto";
import { convexTest } from "convex-test";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { apiKeyFromBytes, hashApiKey, publicKeyId } from "../src/domain/api/keys";
import type { MemberRole } from "../src/domain/schemas/actor";
import type { Scope } from "../src/domain/schemas/scopes";
import { type InvariantTarget, useInvariantTarget } from "../test/invariants";
import { components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import authSchema from "./betterAuth/schema";
import type { SystemJob } from "./functions";
import { auditedInsert } from "./model/audit";
import { guardedDb, newWriteStats } from "./model/db";
import type { ActorContext, ModelCtx } from "./model/types";
import schema from "./schema";

/**
 * convex-test harness (07-testing §3.1).
 *
 *   const t = makeT();                       // registered for assertInvariants() after the test
 *   const owner = await t.asUser("owner");   // Better Auth user + session + member, identity like the real JWT
 *   await owner.mutation(api.invites.create, { … });
 *   const key = await t.asApiKey(["audit:read"]);   // api-key:<prefix> via the server-JWT issuer
 *   const mcp = await t.asMcp(["audit:read"], { client: { name: "claude-code", version: "1" } });
 *   await t.asSystem("cron.integrity.verify").model((ctx) => …);   // model functions as system:<job>
 *
 * Modules: every Convex module except multi-dot files (*.test.ts, *.config.ts, test.setup.ts) and the Better Auth
 * component, which is registered separately. Vite 8's glob does not support the extglob from the convex-test docs.
 */
export const modules = import.meta.glob(["./**/*.*s", "!./**/*.*.*s", "!./betterAuth/**"]);
const authModules = import.meta.glob(["./betterAuth/**/*.ts", "!./betterAuth/**/*.test.ts"]);

// ── test environment (Convex env equivalents; never in production) ────────────────────────────────────
export const TEST_ENV = {
  IS_TEST: "true",
  INSTANCE_NAME: "test",
  CONVEX_SITE_URL: "https://convex-site.test.local",
  SITE_URL: "https://app.test.local",
  BASE_DOMAIN: "test.local",
  PASSKEY_RP_ID: "test.local",
  OWNER_EMAIL: "owner@example.test",
  AUTH_MAIL_SENDER: "memory",
  APP_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1))),
} as const;
for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] ??= v;
if (!process.env.CHECKPOINT_SIGNING_KEY_PEM) {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  process.env.CHECKPOINT_SIGNING_KEY_PEM = await exportPKCS8(privateKey);
}
process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret-0123456789";
if (!process.env.JWKS) {
  // Same format as `pnpm auth:keys better-auth` (scripts/generate-jwks.ts): private JWK encrypted with the secret.
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true, modulusLength: 2048 });
  const encrypted = await symmetricEncrypt({
    key: process.env.BETTER_AUTH_SECRET,
    data: JSON.stringify(await exportJWK(privateKey)),
  });
  process.env.JWKS = JSON.stringify([
    {
      id: "testkey",
      publicKey: JSON.stringify(await exportJWK(publicKey)),
      privateKey: JSON.stringify(encrypted),
      createdAt: Date.now(),
      alg: "RS256",
    },
  ]);
}

export const USER_ISSUER = TEST_ENV.CONVEX_SITE_URL;
export const SERVER_ISSUER = `https://api.${TEST_ENV.BASE_DOMAIN}`;

/** Builds the ctx model functions expect (guarded db + actor) from a raw mutation ctx. */
export function modelCtx(ctx: MutationCtx, actor: ActorContext): ModelCtx {
  return {
    ...ctx,
    db: guardedDb(ctx.db, newWriteStats()),
    actor: actor.actor,
    role: actor.role,
    actorContext: actor,
    now: () => Date.now(),
  };
}

export const SYSTEM_AUTH: ActorContext = { actor: "system:auth", channel: "system" };

let counter = 0;
const unique = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

export interface SeedUserOptions {
  email?: string;
  name?: string;
  expiresAt?: number;
  disabledAt?: number;
  auditor?: { purpose: string; fiscalYears: number[]; organisation?: string };
  totpEnabled?: boolean;
  /** Session already expired (simulates a JWT still valid after sign-out/expiry). */
  sessionExpired?: boolean;
  /** No member row (a Better Auth user that is not a member). */
  noMember?: boolean;
  /** Age of the session at seed time (default 0 = fresh); E-AUD-28 tests use > 10 min. */
  sessionAgeMs?: number;
  /** Re-authentication: create only a new session for this existing user (no new user/member). */
  existingUserId?: string;
}

/** `transactionLimits: true` enforces the Convex per-execution read/write limits (convex-test default: off). */
export function makeT(opts: { transactionLimits?: boolean } = {}) {
  const t = convexTest({ schema, modules, transactionLimits: opts.transactionLimits ?? false });
  t.registerComponent("betterAuth", authSchema, authModules);
  rateLimiterTest.register(t, "rateLimiter");
  // biome-ignore lint/correctness/useHookAtTopLevel: not a React hook (name from 07-testing §5a)
  useInvariantTarget(t as unknown as InvariantTarget);

  async function seedUser(role: MemberRole, opts: SeedUserOptions = {}) {
    const now = Date.now();
    const email = (opts.email ?? `${role}-${unique()}@example.test`).toLowerCase();
    const user = opts.existingUserId
      ? { _id: opts.existingUserId }
      : ((await t.mutation(components.betterAuth.adapter.create, {
          input: {
            model: "user",
            data: { name: opts.name ?? role, email, emailVerified: true, createdAt: now, updatedAt: now },
          },
        })) as { _id: string });
    const createdAt = now - (opts.sessionAgeMs ?? 0);
    const session = (await t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: "session",
        data: {
          token: `tok_${unique()}`,
          userId: user._id,
          expiresAt: opts.sessionExpired ? now - 1000 : now + 7 * 86_400_000,
          createdAt,
          updatedAt: createdAt,
        },
      },
    })) as { _id: string };
    let memberId: Id<"members"> | undefined;
    if (opts.existingUserId) {
      memberId = await t.run(
        async (ctx) =>
          (
            await ctx.db
              .query("members")
              .withIndex("by_authUserId", (q) => q.eq("authUserId", user._id))
              .unique()
          )?._id,
      );
    } else if (!opts.noMember) {
      memberId = await t.run((ctx) =>
        auditedInsert(
          modelCtx(ctx, SYSTEM_AUTH),
          "members",
          {
            authUserId: user._id,
            email,
            name: opts.name ?? role,
            role,
            ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
            ...(opts.disabledAt !== undefined ? { disabledAt: opts.disabledAt, disabledReason: "test" } : {}),
            ...(opts.auditor ? { auditor: { ...opts.auditor, extensions: [] } } : {}),
            totpEnabled: opts.totpEnabled ?? false,
            createdAt: now,
          },
          { action: "member.create", label: email },
        ),
      );
    }
    return { userId: user._id, sessionId: session._id, memberId, email };
  }

  /** A real key (05 §2.1 format) stored with its SHA-256; returns the public id, the plaintext and the hash. */
  async function seedKey(
    scopes: readonly string[],
    channel: "api" | "mcp" | "both",
    name: string,
    extra: { revokedAt?: number; expiresAt?: number; rateLimitPerMinute?: number } = {},
  ) {
    const key = apiKeyFromBytes(crypto.getRandomValues(new Uint8Array(32)));
    const prefix = publicKeyId(key);
    const hash = await hashApiKey(key);
    await t.run((ctx) =>
      auditedInsert(
        modelCtx(ctx, { actor: "user:test-owner", role: "owner", channel: "ui" }),
        "apiKeys",
        {
          name,
          prefix,
          last4: key.slice(-4),
          hash,
          scopes: [...scopes],
          channel,
          createdAt: Date.now(),
          createdBy: "user:test-owner",
          ...extra,
        },
        { action: "api_key.create", label: name },
      ),
    );
    return { prefix, key, hash };
  }

  return Object.assign(t, {
    seedUser,
    /** Signed-in member with `role` (default owner): identity as the Better Auth JWT would carry it. */
    async asUser(role: MemberRole = "owner", opts: SeedUserOptions = {}) {
      const u = await seedUser(role, opts);
      const accessor = t.withIdentity({
        issuer: USER_ISSUER,
        subject: u.userId,
        sessionId: u.sessionId,
        email: u.email,
        name: opts.name ?? role,
      } as never);
      return Object.assign(accessor, { ...u, actor: `user:${u.userId}` as const, role });
    },
    /** REST caller with an API key: server JWT `sub = api-key:<prefix>`. */
    seedKey,
    async asApiKey(
      scopes: readonly Scope[],
      opts: {
        name?: string;
        revokedAt?: number;
        expiresAt?: number;
        rateLimitPerMinute?: number;
        tokenScopes?: readonly string[];
        /** Claim a different key hash than the stored one (API-006 tests). */
        keyHash?: string;
      } = {},
    ) {
      const name = opts.name ?? "website";
      const { prefix, key, hash } = await seedKey(scopes, "api", name, {
        ...(opts.revokedAt !== undefined ? { revokedAt: opts.revokedAt } : {}),
        ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
        ...(opts.rateLimitPerMinute !== undefined ? { rateLimitPerMinute: opts.rateLimitPerMinute } : {}),
      });
      const accessor = t.withIdentity({
        issuer: SERVER_ISSUER,
        subject: `api-key:${prefix}`,
        scopes: [...(opts.tokenScopes ?? scopes)],
        keyName: name,
        keyHash: opts.keyHash ?? hash,
      } as never);
      return Object.assign(accessor, { prefix, key, hash, actor: `api-key:${prefix}` as const });
    },
    /** MCP caller: server JWT `sub = mcp:<prefix>` with MCP client info. */
    async asMcp(scopes: readonly Scope[], opts: { name?: string; client?: { name: string; version: string } } = {}) {
      const name = opts.name ?? "Claude";
      const { prefix, key, hash } = await seedKey(scopes, "mcp", name);
      const accessor = t.withIdentity({
        issuer: SERVER_ISSUER,
        subject: `mcp:${prefix}`,
        scopes: [...scopes],
        keyName: name,
        keyHash: hash,
        client: opts.client ?? { name: "claude-code", version: "test" },
      } as never);
      return Object.assign(accessor, { prefix, key, hash, actor: `mcp:${prefix}` as const });
    },
    /** System job context: internal functions need no identity; `model()` runs model code as system:<job>. */
    asSystem(job: SystemJob) {
      const actorContext: ActorContext = {
        actor: `system:${job}`,
        channel: job.startsWith("cron.") ? "cron" : "system",
      };
      return {
        actorContext,
        model: <T>(fn: (ctx: ModelCtx) => Promise<T>) => t.run((ctx) => fn(modelCtx(ctx, actorContext))),
      };
    },
    /** Runs model code with an arbitrary actor context. */
    model<T>(actor: ActorContext, fn: (ctx: ModelCtx) => Promise<T>) {
      return t.run((ctx) => fn(modelCtx(ctx, actor)));
    },
  });
}

export type TestT = ReturnType<typeof makeT>;
