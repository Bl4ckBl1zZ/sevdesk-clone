import { describe, expect, test } from "vitest";
import { type ProjectRefRow, resolveProjectRef } from "./lookup";

const p = (id: string, number: string, name: string, status: ProjectRefRow["status"] = "active"): ProjectRefRow => ({
  id,
  number,
  name,
  status,
});

const projects = [
  p("a", "PRJ-00001", "Website Relaunch"),
  p("b", "PRJ-00002", "Website Wartung"),
  p("c", "PRJ-00003", "Shop"),
  p("d", "PRJ-00004", "Altprojekt", "archived"),
  p("e", "PRJ-00005", "Shop Altbestand", "archived"),
];

const resolved = (input: string, list = projects) => {
  const r = resolveProjectRef(input, list);
  return r.ok ? r.value.id : r.error.code;
};

describe("E-PRJ-22 project lookup for time_entry_log", () => {
  test("E-PRJ-22 TST-PRJ-18 an ambiguous name returns a structured error with candidates and the German text", () => {
    const r = resolveProjectRef("Website", projects);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("project_ambiguous");
    expect(r.error.message).toBe(
      "Projekt „Website“ ist nicht eindeutig: PRJ-00001 Website Relaunch, PRJ-00002 Website Wartung. Bitte project_id angeben.",
    );
    expect(r.error.candidates).toEqual([
      { id: "a", number: "PRJ-00001", name: "Website Relaunch" },
      { id: "b", number: "PRJ-00002", name: "Website Wartung" },
    ]);
  });

  test("E-PRJ-22 at most five candidates are listed", () => {
    const many = Array.from({ length: 7 }, (_, i) => p(`x${i}`, `PRJ-0001${i}`, `Kampagne ${i}`));
    const r = resolveProjectRef("kampagne", many);
    expect(r.ok ? [] : r.error.candidates).toHaveLength(5);
    expect(r.ok ? "" : r.error.message.split(", ")).toHaveLength(5);
  });

  test("E-PRJ-22 ID, exact number, exact name and a unique partial match resolve; nothing matching → not found", () => {
    expect(resolved("b")).toBe("b");
    expect(resolved("prj-00003")).toBe("c");
    expect(resolved("shop")).toBe("c"); // exact name wins over „Shop Altbestand“
    expect(resolved("relaunch")).toBe("a");
    expect(resolved("Wärtung")).toBe("b"); // folded like the search index (ä → a)
    expect(resolved("Wartungsvertrag")).toBe("project_not_found");
    const none = resolveProjectRef("Buchhaltung", projects);
    expect(none.ok ? null : none.error).toMatchObject({
      code: "project_not_found",
      message: "Projekt „Buchhaltung“ nicht gefunden. Bitte project_id oder die Projektnummer angeben.",
      candidates: [],
    });
    expect(resolved("   ")).toBe("project_not_found");
  });

  test("E-PRJ-21 archived projects only match when no active project does (the caller then blocks logging)", () => {
    expect(resolved("Altprojekt")).toBe("d");
    expect(resolved("alt")).toBe("project_ambiguous"); // both archived „Alt…“ projects
    expect(resolved("Shop Alt")).toBe("e");
  });
});
