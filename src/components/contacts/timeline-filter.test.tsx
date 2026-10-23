import { fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, test } from "vitest";
import { filterTimeline, type TimelineFilter } from "@/domain/contacts/timeline";
import { renderWithIntl } from "@/i18n/test-utils";
import { TimelineFilterBar } from "./timeline-filter";

const ENTRIES = [
  { key: "n1", at: Date.parse("2026-10-01T08:00:00Z"), kind: "note" as const, text: "Rahmenvertrag besprochen" },
  { key: "c1", at: Date.parse("2026-09-15T12:00:00Z"), kind: "call" as const, text: "Preisliste 2027" },
  { key: "d1", at: Date.parse("2026-10-05T10:00:00Z"), kind: "derived" as const, text: "Rechnung fertiggestellt" },
];

function Harness() {
  const [f, setF] = useState<TimelineFilter>({ kind: "all" });
  return (
    <>
      <TimelineFilterBar value={f} onChange={setF} />
      <ul aria-label="Ergebnis">
        {filterTimeline(ENTRIES, f).map((e) => (
          <li key={e.key}>{e.text}</li>
        ))}
      </ul>
    </>
  );
}

describe("TimelineFilterBar", () => {
  test("CON-124 the Verlauf can be filtered by kind and period and searched within notes", () => {
    renderWithIntl(<Harness />);
    const items = () => screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items()).toHaveLength(3);
    fireEvent.change(screen.getByLabelText("Art"), { target: { value: "derived" } });
    expect(items()).toEqual(["Rechnung fertiggestellt"]);
    fireEvent.change(screen.getByLabelText("Art"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Von"), { target: { value: "2026-10-01" } });
    expect(items()).toEqual(["Rahmenvertrag besprochen", "Rechnung fertiggestellt"]);
    fireEvent.change(screen.getByLabelText("In Notizen suchen"), { target: { value: "RAHMEN" } });
    expect(items()).toEqual(["Rahmenvertrag besprochen"]);
    expect(screen.getByRole("group", { name: "Verlauf filtern" })).toBeInTheDocument();
  });
});
