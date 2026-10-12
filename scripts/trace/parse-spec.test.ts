import { expect, test } from "vitest";
import { leadingIds } from "./ids";
import { parseSpec } from "./parse-spec";
import { scanTests } from "./scan-tests";

const md = `
| ID | Requirement | Priority | Phase | Compliance refs |
|---|---|---|---|---|
| DOC-01 | One table | MUST | P1 | UST-11 |
| **DOC-02** | Lifecycle | SHOULD | P0/P1 | GOBD-06 |

| ID | Rule | Enforced in | Test | Phase |
|---|---|---|---|---|
| UST-06 | Numbering | convex | C | P1 |

| ID | As … | I want … | so that … |
|---|---|---|---|
| US-01 | owner | x | y |

| ID | Input | Expected |
|---|---|---|
| ER03-01 | a | b |
`;

test("SMOKE trace parses requirement tables with priority and lowest phase", () => {
  const reqs = parseSpec("x.md", md);
  expect(reqs.map((r) => [r.id, r.priority, r.phase])).toEqual([
    ["DOC-01", "MUST", 1],
    ["DOC-02", "SHOULD", 0],
    ["UST-06", "MUST", 1],
    ["ER03-01", "CASE", null],
  ]);
});

test("SMOKE trace extracts leading requirement IDs from test titles", () => {
  expect(leadingIds("INV-012 assigns the number atomically")).toEqual(["INV-012"]);
  expect(leadingIds("EC-013/RI-02 drafts never carry a number")).toEqual(["EC-013", "RI-02"]);
  expect(leadingIds("UST-09, UST-10 rounding")).toEqual(["UST-09", "UST-10"]);
  expect(leadingIds("EC-DOC-01 revalidates")).toEqual(["EC-DOC-01"]);
  expect(leadingIds("SMOKE no id")).toEqual([]);
  expect(leadingIds("assigns INV-012 later")).toEqual([]);
});

test("SMOKE trace scans vitest and playwright test calls", () => {
  const src = [
    `test("INV-012 a", () => {});`,
    `it.todo('GOBD-06 b');`,
    "test.skipIf(!url)(`UST-06 c`, () => {});",
    `test.describe("F04 not an id", () => {});`,
  ].join("\n");
  expect(scanTests("f.test.ts", src).map((r) => [r.id, r.todo])).toEqual([
    ["INV-012", false],
    ["GOBD-06", true],
    ["UST-06", false],
  ]);
});
