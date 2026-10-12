import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const dir = import.meta.dirname;

describe("runbooks", () => {
  test("DSGVO-05 the breach-response runbook covers containment, evidence, the 72-hour notice and documentation", () => {
    const md = readFileSync(join(dir, "incident.md"), "utf8");
    for (const required of [
      "72 hours",
      "Art. 33",
      "Art. 34",
      "Art. 33 (5)",
      "## 2. Contain",
      "## 3. Preserve evidence",
      "## 4. Assess the risk",
      "## 7. Document",
      "Sitzungen abmelden",
      "SECRETS_ROTATED_ON",
      "Processors",
    ]) {
      expect(md, required).toContain(required);
    }
  });

  test("DSGVO-05 relative links between runbooks resolve", () => {
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      const md = readFileSync(join(dir, file), "utf8");
      for (const [, target] of md.matchAll(/\]\(([\w.-]+\.md)\)/g)) {
        expect(existsSync(join(dir, target ?? "")), `${file} → ${target}`).toBe(true);
      }
    }
  });
});
