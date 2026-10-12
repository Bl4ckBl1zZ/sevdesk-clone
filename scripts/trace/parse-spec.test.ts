import { expect, test } from "vitest";
import { buildCoverage } from "./coverage";
import { isAnnotationId, leadingIds } from "./ids";
import { mergeRegistry, parseSpec } from "./parse-spec";
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

| # | Case | Behaviour | Message (DE) |
|---|---|---|---|
| E-AUD-17 | Migration changes protected content | Aborted (EC-184) | „Migration abgebrochen" |

| ID | Situation | Required behaviour | Compliance · 10-edge-cases | Test |
|---|---|---|---|---|
| EC-SET-01 | Counter lowered | Refused | GOBD-06 | T-SET-034 |

| Test ID | Given / When / Then | Type | Covers req IDs |
|---|---|---|---|
| T-SET-005 | MAIL-03: footer of a GmbH (BT-81 untouched) | G | DOC-01 |
| TST-AUD-31 | Sessions | C, E | E-AUD-17, DOC-02, X-99 |

| Test ID | Suite | Type | Covers |
|---|---|---|---|
| T-TAB-01 | Tables | U | UST-06 |

| # | Table / field | Change | Why |
|---|---|---|---|
| D-01 | invoices | new | x |

| # | Question | Proposed default |
|---|---|---|
| Q-01 | ? | ! |
`;

test("SMOKE trace parses requirement tables with priority and lowest phase", () => {
  const reqs = parseSpec("x.md", md);
  expect(reqs.map((r) => [r.id, r.kind, r.priority, r.phase])).toEqual([
    ["DOC-01", "requirement", "MUST", 1],
    ["DOC-02", "requirement", "SHOULD", 0],
    ["UST-06", "requirement", "MUST", 1],
    ["ER03-01", "test-case", "CASE", null],
    ["E-AUD-17", "edge-case", "MUST", null],
    ["EC-SET-01", "edge-case", "MUST", null],
    ["T-SET-005", "test-case", "CASE", null],
    ["TST-AUD-31", "test-case", "CASE", null],
    ["T-TAB-01", "test-case", "CASE", null],
  ]);
});

test("SMOKE trace reads the covered requirement IDs of test-case rows (Covers column only)", () => {
  const covers = Object.fromEntries(parseSpec("x.md", md).map((r) => [r.id, r.covers]));
  expect(covers["T-SET-005"]).toEqual(["DOC-01"]);
  expect(covers["TST-AUD-31"]).toEqual(["E-AUD-17", "DOC-02", "X-99"]);
  expect(covers["T-TAB-01"]).toEqual(["UST-06"]);
  expect(covers["EC-SET-01"]).toEqual([]);
});

test("SMOKE trace maps test-case IDs to their requirements and still reports unknown IDs", () => {
  const registry = mergeRegistry([parseSpec("x.md", md)]);
  const src = [
    `test("T-SET-005 footer", () => {});`,
    `test("TST-AUD-31 sessions", () => {});`,
    `test("E-AUD-17 abort message", () => {});`,
    `test("SET-092 BT-81 payment means code", () => {});`,
    `test("T-SET-999 typo", () => {});`,
    `test("D-01 data model change is not a test target", () => {});`,
    `test("BUG-7 regression", () => {});`,
    `test.todo("T-TAB-01 later");`,
  ].join("\n");
  const { testsById, unknown } = buildCoverage(registry, scanTests("f.test.ts", src));
  const titles = (id: string) => (testsById.get(id) ?? []).map((t) => t.title);
  expect(titles("T-SET-005")).toEqual(["T-SET-005 footer"]);
  expect(titles("DOC-01")).toEqual(["T-SET-005 footer"]);
  expect(titles("DOC-02")).toEqual(["TST-AUD-31 sessions"]);
  expect(titles("E-AUD-17")).toEqual(["TST-AUD-31 sessions", "E-AUD-17 abort message"]);
  expect(testsById.has("X-99")).toBe(false); // covers entries outside the registry are ignored
  expect(testsById.has("UST-06")).toBe(false); // todo tests cover nothing
  expect(testsById.has("BT-81")).toBe(false);
  expect(unknown.sort()).toEqual(["D-01", "SET-092", "T-SET-999"]);
});

test("SMOKE trace treats EN 16931 business terms and groups as annotations", () => {
  expect(isAnnotationId("BT-81")).toBe(true);
  expect(isAnnotationId("BG-16")).toBe(true);
  expect(isAnnotationId("BTX-81")).toBe(false);
  expect(isAnnotationId("SET-092")).toBe(false);
  const refs = scanTests("f.test.ts", `test("SET-092 ER-10 BT-81 is derived from the kind", () => {});`);
  expect(refs.map((r) => r.id)).toEqual(["SET-092", "ER-10"]);
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
