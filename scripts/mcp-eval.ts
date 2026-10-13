/**
 * MCP eval harness (06 §7). Two modes:
 *
 *   pnpm mcp:eval --list                    prints the German prompts for the manual run in Claude Code
 *   RECHNUNG_MCP_URL=https://api.<BASE_DOMAIN>/api/mcp RECHNUNG_MCP_KEY=sk_live_… pnpm mcp:eval [EVAL-C01 …]
 *                                           replays the reference tool calls against a live (seeded test) instance
 *
 * The live mode writes data (setup steps and the scenarios themselves) — run it only against a test instance.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { runScenario } from "../test/mcp-eval/runner";
import { SCENARIOS } from "../test/mcp-eval/scenarios";

const args = process.argv.slice(2);

if (args.includes("--list")) {
  for (const s of SCENARIOS) {
    console.log(`${s.id}  ${s.prompt}\n         Erfolg: ${s.success}\n`);
  }
  process.exit(0);
}

const url = process.env.RECHNUNG_MCP_URL;
const key = process.env.RECHNUNG_MCP_KEY;
if (!url || !key) {
  console.error("RECHNUNG_MCP_URL und RECHNUNG_MCP_KEY setzen (nur gegen eine Testinstanz!) oder --list verwenden.");
  process.exit(2);
}

const selected = args.length > 0 ? SCENARIOS.filter((s) => args.includes(s.id)) : SCENARIOS;
let failed = 0;
for (const scenario of selected) {
  const client = new Client({ name: "mcp-eval", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }),
  );
  const outcomes = await runScenario(client, scenario);
  await client.close();
  const ok = outcomes.length === scenario.steps.length && outcomes.every((o) => o.ok);
  if (!ok) failed++;
  console.log(`${ok ? "✔" : "✖"} ${scenario.id}`);
  for (const o of outcomes.filter((x) => !x.ok)) console.log(`    Schritt ${o.step} ${o.tool}: ${o.message}`);
}
process.exit(failed > 0 ? 1 : 0);
