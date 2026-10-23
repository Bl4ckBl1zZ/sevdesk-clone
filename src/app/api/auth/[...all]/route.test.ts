import { afterEach, beforeEach, expect, test, vi } from "vitest";

const created = vi.hoisted(() => ({
  options: [] as { convexUrl: string; convexSiteUrl: string }[],
  calls: [] as { verb: string; url: string }[],
}));
vi.mock("@convex-dev/better-auth/nextjs", () => ({
  convexBetterAuthNextJs: (options: { convexUrl: string; convexSiteUrl: string }) => {
    created.options.push(options);
    const forward = (verb: string) => async (request: Request) => {
      created.calls.push({ verb, url: request.url });
      return new Response(null, { status: 204 });
    };
    return { handler: { GET: forward("GET"), POST: forward("POST") } };
  },
}));

const ENV = [
  "CONVEX_URL_INTERNAL",
  "NEXT_PUBLIC_CONVEX_URL",
  "CONVEX_SITE_URL_INTERNAL",
  "NEXT_PUBLIC_CONVEX_SITE_URL",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.resetModules();
  created.options.length = 0;
  created.calls.length = 0;
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test("SEC-01 /api/auth/* proxies GET and POST to Better Auth on the internal Convex site origin (02 §4.1)", async () => {
  process.env.CONVEX_URL_INTERNAL = "http://backend:3210";
  process.env.CONVEX_SITE_URL_INTERNAL = "http://backend:3211";
  process.env.NEXT_PUBLIC_CONVEX_SITE_URL = "https://convex-site.example.org";
  const { GET, POST } = await import("./route");
  const get = await GET(new Request("https://app.example.org/api/auth/get-session"));
  const post = await POST(new Request("https://app.example.org/api/auth/sign-out", { method: "POST" }));
  expect([get.status, post.status]).toEqual([204, 204]);
  expect(created.calls).toEqual([
    { verb: "GET", url: "https://app.example.org/api/auth/get-session" },
    { verb: "POST", url: "https://app.example.org/api/auth/sign-out" },
  ]);
  // The internal origins win over the public ones, and the helpers are built once per process.
  expect(created.options).toEqual([{ convexUrl: "http://backend:3210", convexSiteUrl: "http://backend:3211" }]);
});

test("SEC-01 without any Convex URL the auth proxy fails loudly in German instead of calling a wrong origin", async () => {
  const { GET } = await import("./route");
  expect(() => GET(new Request("https://app.example.org/api/auth/get-session"))).toThrow("CONVEX_URL_INTERNAL fehlt.");
  expect(created.calls).toEqual([]);
});
