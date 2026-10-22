import { api } from "@convex/_generated/api";
import { describe, expect, test } from "vitest";
import { toolError } from "../tool";
import { projectTools } from "./projects";

const RAW_A = "k17abcdefghijklmnop";
const RAW_B = "k17qrstuvwxyzabcdef";
const RAW_E = "k17entryentryentry";

function tool() {
  const t = projectTools.find((x) => x.name === "time_entry_log");
  if (!t) throw new Error("missing tool");
  return t;
}

describe("MCP time_entry_log (F11 §7, 06 §3.9)", () => {
  test("PRJ-021 TST-PRJ-18 time_entry_log is a write tool with scope time:write; prj_ IDs are decoded and the result encoded", async () => {
    const t = tool();
    expect(t.scopes).toEqual(["time:write"]);
    expect(t.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    const calls: { fn: unknown; args: unknown }[] = [];
    const convex = {
      mutation: async (fn: unknown, args: unknown) => {
        calls.push({ fn, args });
        return {
          id: RAW_E,
          warnings: [],
          entry: {
            date: "2026-10-23",
            durationMinutes: 120,
            description: "Workshop",
            billable: true,
            hourlyRateMicros: 900_000,
            status: "open",
            source: "mcp",
          },
          project: { id: RAW_A, number: "PRJ-00001", name: "Website Relaunch" },
          budget: {
            kind: "hours",
            consumed: 120,
            budget: 600,
            ratioBp: 2000,
            level: "ok",
            label: "2:00 h von 10:00 h",
          },
        };
      },
    } as never;
    const out = (await t.handler({ project: `prj_${RAW_A}`, duration: "2h", description: "Workshop" }, {
      convex,
    } as never)) as Record<string, unknown>;
    expect(calls).toEqual([
      { fn: api.timeEntries.log, args: { project: RAW_A, duration: "2h", description: "Workshop" } },
    ]);
    expect(out).toMatchObject({
      id: `tim_${RAW_E}`,
      project: { id: `prj_${RAW_A}`, number: "PRJ-00001" },
      entry: { duration_minutes: 120, source: "mcp" },
      budget: { ratio_bp: 2000, label: "2:00 h von 10:00 h" },
    });
  });

  test("E-PRJ-22 an ambiguous project becomes isError with up to five prj_ candidates and the German message", async () => {
    const message =
      "Projekt „Website“ ist nicht eindeutig: PRJ-00001 Website Relaunch, PRJ-00002 Website Wartung. Bitte project_id angeben.";
    const convex = {
      mutation: async () => {
        throw {
          data: {
            code: "invalid_input",
            message,
            reason: "project_ambiguous",
            field: "project",
            candidates: [
              { id: RAW_A, number: "PRJ-00001", name: "Website Relaunch" },
              { id: RAW_B, number: "PRJ-00002", name: "Website Wartung" },
            ],
          },
        };
      },
    } as never;
    const error = await tool()
      .handler({ project: "Website", duration: "2h", description: "Workshop" }, { convex } as never)
      .then(() => expect.unreachable("expected an error"))
      .catch((e: unknown) => e);
    const r = toolError(error);
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0]?.text ?? "{}").error;
    expect(body).toMatchObject({ code: "validation_failed", message });
    expect(body.errors[0]).toMatchObject({ code: "project_ambiguous", field: "project" });
    expect(body.candidates).toEqual([
      { id: `prj_${RAW_A}`, number: "PRJ-00001", name: "Website Relaunch" },
      { id: `prj_${RAW_B}`, number: "PRJ-00002", name: "Website Wartung" },
    ]);
  });
});
