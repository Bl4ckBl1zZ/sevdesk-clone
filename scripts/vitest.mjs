#!/usr/bin/env node
// `pnpm test [-p <project>[,<project>]] [vitest args…]` → `vitest run --project <project> …`
// Vitest itself has no `-p` shorthand; CLAUDE.md documents `pnpm test -p domain|convex|server|ui|integration`.
import { spawnSync } from "node:child_process";

const out = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  let value;
  if (a === "-p" || a === "--project") value = args[++i];
  else if (a.startsWith("-p=")) value = a.slice(3);
  else if (a.startsWith("--project=")) value = a.slice(10);
  else {
    out.push(a);
    continue;
  }
  if (!value) {
    console.error(`${a} needs a project name (domain, convex, server, ui, integration)`);
    process.exit(2);
  }
  for (const name of value.split(",")) out.push("--project", name);
}

const watch = out.includes("--watch") || out.includes("-w");
const cmd = watch ? out : ["run", ...out];
const res = spawnSync("vitest", cmd, { stdio: "inherit", shell: process.platform === "win32" });
process.exit(res.status ?? 1);
