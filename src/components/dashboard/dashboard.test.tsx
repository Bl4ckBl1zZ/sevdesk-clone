import { screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { monthWindow } from "@/domain/reports/dashboard";
import type { CalendarDate } from "@/domain/time/calendar-date";
import { renderWithIntl } from "@/i18n/test-utils";
import { Dashboard, type DashboardData, DashboardView } from "./dashboard";

const months = monthWindow("2026-10-18" as CalendarDate).map((m, i) => ({
  ...m,
  incomeCents: i === 11 ? 150_000 : i === 10 ? 80_000 : 0,
  expenseCents: i === 11 ? 20_000 : i === 9 ? 5_000 : 0,
  profitCents: (i === 11 ? 130_000 : 0) + (i === 10 ? 80_000 : 0) - (i === 9 ? 5_000 : 0),
}));

const fullResult = {
  from: "2025-11-01",
  to: "2026-10-18",
  months,
  incomeCents: 230_000,
  expenseCents: 25_000,
  profitCents: 205_000,
};

const full: DashboardData = {
  today: "2026-10-18" as CalendarDate,
  role: "owner",
  greetingName: "Erika",
  result: fullResult,
  receivables: {
    totalCents: 42_000,
    overdue: { count: 2, cents: 15_000 },
    open: { count: 1, cents: 20_000 },
    partiallyPaid: { count: 1, cents: 7_000 },
  },
  ku: {
    year: 2026,
    turnoverCents: 2_500_000,
    limitCents: 10_000_000,
    priorYearLimitCents: 2_500_000,
    currentYearLimitCents: 10_000_000,
    foundingYearLimitCents: 2_500_000,
    foundingYear: false,
    shareBp: 2_500,
    level: "ok",
  },
  monitors: {
    ku: [
      { key: "ku_prior_year", year: 2025, amountCents: 2_100_000, limitCents: 2_500_000, bp: 8_400, level: "warn_80" },
      { key: "ku_current_year", year: 2026, amountCents: 2_500_000, limitCents: 10_000_000, bp: 2_500, level: "ok" },
    ],
    oss: { currentYearEurCents: 250_000, priorYearEurCents: 0, limitCents: 1_000_000 },
    notices: [
      {
        code: "er03_mandatory_next_year",
        severity: "warning",
        message:
          "Gesamtumsatz 2026: 800.000,01 € (über 800.000,00 €). Ab 01.01.2027 müssen Sie B2B-Rechnungen im Inland als E-Rechnung ausstellen.",
      },
    ],
  },
  bank: {
    accountCount: 1,
    totalCents: 1_234_567,
    accountsWithoutBalance: 0,
    latest: [
      { id: "t1", bookingDate: "2026-10-15", amountCents: -1_250, label: "Kontoführung" },
      { id: "t2", bookingDate: "2026-10-12", amountCents: 50_000, label: "Muster GmbH" },
    ],
  },
  matching: { total: 10, assigned: 9, unassigned: 1, percent: 90, level: "medium" },
  topCustomers: [
    { contactId: "c1", name: "Muster GmbH", amountCents: 75_000 },
    { contactId: "c2", name: "Beispiel AG", amountCents: 50_000 },
  ],
  activity: [
    { at: Date.UTC(2026, 9, 18, 8, 5), text: "RE-2026-0001 fertiggestellt", by: "Inhaber" },
    { at: Date.UTC(2026, 9, 17, 12, 0), text: "Kontakt Muster GmbH angelegt", by: "API" },
  ],
};

const empty: DashboardData = {
  ...full,
  greetingName: null,
  result: {
    ...fullResult,
    months: months.map((m) => ({ ...m, incomeCents: 0, expenseCents: 0, profitCents: 0 })),
    incomeCents: 0,
    expenseCents: 0,
    profitCents: 0,
  },
  receivables: {
    totalCents: 0,
    overdue: { count: 0, cents: 0 },
    open: { count: 0, cents: 0 },
    partiallyPaid: { count: 0, cents: 0 },
  },
  ku: null,
  monitors: { ku: [], oss: null, notices: [] },
  bank: { accountCount: 0, totalCents: 0, accountsWithoutBalance: 0, latest: [] },
  matching: { total: 0, assigned: 0, unassigned: 0, percent: null, level: null },
  topCustomers: [],
  activity: [],
};

/** Accessible names keep the no-break space of the euro format; compare with normalised whitespace. */
const named = (expected: string | RegExp) => (name: string) => {
  const n = name.replace(/\s+/g, " ");
  return typeof expected === "string" ? n === expected : expected.test(n);
};

const card = (title: string) => {
  const heading = screen.getByRole("heading", { level: 2, name: title });
  const region = heading.closest("section");
  if (!region) throw new Error(`no section for ${title}`);
  return within(region);
};

describe("turnover monitors (TAX-012, TAX-013, TAX-017)", () => {
  test("TAX-012 TAX-013 the card shows the prior-year KU bar, the OSS progress and the 800k notices", () => {
    renderWithIntl(<DashboardView data={full} />);
    const c = card("Umsatzgrenzen");
    expect(c.getByText("Gesamtumsatz 2025 (Vorjahr)")).toBeInTheDocument();
    expect(
      c.getByRole("progressbar", { name: named("Gesamtumsatz 2025: 84 % der Vorjahresgrenze von 25.000,00 €") }),
    ).toBeInTheDocument();
    expect(
      c.getByRole("progressbar", { name: named("EU-Fernverkäufe: 25 % der Lieferschwelle von 10.000,00 €") }),
    ).toBeInTheDocument();
    expect(
      c.getByText(/Ab 01.01.2027 müssen Sie B2B-Rechnungen im Inland als E-Rechnung ausstellen/),
    ).toBeInTheDocument();
  });

  test("TAX-012 without monitor data the card is not shown", () => {
    renderWithIntl(<DashboardView data={empty} />);
    expect(screen.queryByRole("heading", { level: 2, name: "Umsatzgrenzen" })).toBeNull();
  });
});

describe("DASH-001…009 Übersicht", () => {
  test("DASH-001 greets the member by first name", () => {
    renderWithIntl(<DashboardView data={full} />);
    expect(screen.getByRole("heading", { level: 1, name: "Herzlich Willkommen, Erika" })).toBeInTheDocument();
  });

  test("DASH-001 the h1 exists before the overview loads (no Convex client → loading fallback)", () => {
    renderWithIntl(<Dashboard todos={<p>Aufgabe</p>} />);
    const h1 = screen.getByRole("heading", { level: 1, name: "Herzlich Willkommen" });
    expect(h1).toHaveAttribute("id", "page-title");
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  });

  test("DASH-001 without a name the heading is just „Herzlich Willkommen“", () => {
    renderWithIntl(<DashboardView data={empty} />);
    expect(screen.getByRole("heading", { level: 1, name: "Herzlich Willkommen" })).toBeInTheDocument();
  });

  test("DASH-002 four quick-action links; read-only roles only see the read action", () => {
    const { unmount } = renderWithIntl(<DashboardView data={full} />);
    const nav = within(screen.getByRole("navigation", { name: "Schnellaktionen" }));
    expect(nav.getAllByRole("link").map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
      ["Rechnung schreiben", "/rechnungen/neu"],
      ["Ausgabe hochladen", "/posteingang"],
      ["Zahlungen zuordnen", "/bank/zuordnungen"],
      ["UStVA vorbereiten", "/steuern/ustva"],
    ]);
    unmount();
    renderWithIntl(<DashboardView data={{ ...full, role: "viewer" }} />);
    const viewerNav = within(screen.getByRole("navigation", { name: "Schnellaktionen" }));
    expect(viewerNav.getAllByRole("link").map((l) => l.textContent)).toEqual(["UStVA vorbereiten"]);
  });

  test("DASH-003 Gewinn vor Steuern with Einnahmen/Ausgaben and an accessible monthly table", () => {
    renderWithIntl(<DashboardView data={full} />);
    const c = card("Gewinn vor Steuern");
    expect(c.getByText("2.050,00 €")).toBeInTheDocument();
    expect(c.getByText("2.300,00 €")).toBeInTheDocument();
    expect(c.getByText("250,00 €")).toBeInTheDocument();
    expect(c.getByRole("img", { name: /Einnahmen und Ausgaben je Monat/ })).toBeInTheDocument();
    const table = c.getByRole("table", { name: "Einnahmen und Ausgaben je Monat" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(13);
    expect(rows.at(-1)).toHaveTextContent("Okt 26");
    expect(rows.at(-1)).toHaveTextContent("1.500,00 €");
    expect(c.getByText("Letzte 12 Monate")).toBeInTheDocument();
  });

  test("DASH-003 empty journal → empty text instead of bars", () => {
    renderWithIntl(<DashboardView data={empty} />);
    expect(card("Gewinn vor Steuern").getByText(/noch keine Buchungen/)).toBeInTheDocument();
  });

  test("DASH-004 Ausstehende Rechnungen: total and the three filtered rows", () => {
    renderWithIntl(<DashboardView data={full} />);
    const c = card("Ausstehende Rechnungen");
    expect(c.getByText("420,00 €")).toBeInTheDocument();
    const overdue = c.getByRole("link", { name: named("Fällig: 2 Rechnungen, 150,00 €") });
    expect(overdue).toHaveAttribute("href", "/rechnungen?status=overdue");
    expect(c.getByRole("link", { name: named("Offen: 1 Rechnung, 200,00 €") })).toHaveAttribute(
      "href",
      "/rechnungen?status=open",
    );
    expect(c.getByRole("link", { name: named("Teilbezahlt: 1 Rechnung, 70,00 €") })).toHaveAttribute(
      "href",
      "/rechnungen?status=open",
    );
    expect(c.getByRole("link", { name: "Rechnung schreiben" })).toHaveAttribute("href", "/rechnungen/neu");
  });

  test("DASH-005 KU card with turnover, progress against the limit and the explanation", () => {
    renderWithIntl(<DashboardView data={full} />);
    const c = card("Kleinunternehmergrenze");
    expect(c.getByText("Umsatz 2026")).toBeInTheDocument();
    expect(c.getByText("25.000,00 €")).toBeInTheDocument();
    expect(c.getByText("Umsatzsteuerpflicht 100.000,00 €")).toBeInTheDocument();
    expect(c.getByRole("progressbar", { name: named(/25 % der Grenze von 100.000,00 €/) })).toBeInTheDocument();
    expect(c.getByText(/höchstens 25.000,00 € betrug und im laufenden Jahr 100.000,00 €/)).toBeInTheDocument();
  });

  test("DASH-005 the KU card is not rendered when the company is not Kleinunternehmer", () => {
    renderWithIntl(<DashboardView data={empty} />);
    expect(screen.queryByRole("heading", { name: "Kleinunternehmergrenze" })).toBeNull();
  });

  test("DASH-006 Bank: Gesamtsaldo, latest transactions and the link to all payments", () => {
    renderWithIntl(<DashboardView data={full} />);
    const c = card("Bank");
    expect(c.getByText("12.345,67 €")).toBeInTheDocument();
    const items = c.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Kontoführung");
    expect(items[0]).toHaveTextContent("15.10.2026");
    expect(items[0]).toHaveTextContent("-12,50 €");
    expect(items[1]).toHaveTextContent("+500,00 €");
    expect(c.getByRole("link", { name: "Alle Zahlungen anzeigen" })).toHaveAttribute("href", "/bank");
  });

  test("DASH-006 no bank account → empty state with a link to /bank", () => {
    renderWithIntl(<DashboardView data={empty} />);
    const c = card("Bank");
    expect(c.getByText("Noch kein Bankkonto angelegt.")).toBeInTheDocument();
    expect(c.getByRole("link", { name: "Bankkonto hinzufügen" })).toHaveAttribute("href", "/bank");
  });

  test("DASH-007 Zuordnungsquote with scale, unassigned count and the Zuordnen link", () => {
    renderWithIntl(<DashboardView data={full} />);
    const c = card("Zuordnungsquote");
    expect(c.getByText("90 %")).toBeInTheDocument();
    expect(c.getByText("Gut")).toBeInTheDocument();
    expect(c.getByText("Zahlungen ohne Zuordnung: 1")).toBeInTheDocument();
    expect(c.getByRole("img", { name: "Zuordnungsquote 90 %" })).toBeInTheDocument();
    expect(c.getByRole("link", { name: "Zuordnen" })).toHaveAttribute("href", "/bank/zuordnungen");
  });

  test("DASH-007 zero transactions → empty text, no percentage", () => {
    renderWithIntl(<DashboardView data={empty} />);
    const c = card("Zuordnungsquote");
    expect(c.getByText("Noch keine Bankumsätze vorhanden.")).toBeInTheDocument();
    expect(c.queryByText(/ %$/)).toBeNull();
  });

  test("DASH-008 Top 5 Kunden as a ranked list; empty text", () => {
    const { unmount } = renderWithIntl(<DashboardView data={full} />);
    const list = card("Top 5 Kunden").getByRole("list");
    const items = within(list).getAllByRole("listitem");
    expect(list.tagName).toBe("OL");
    expect(items[0]).toHaveTextContent("Muster GmbH");
    expect(items[0]).toHaveTextContent("750,00 €");
    expect(items[1]).toHaveTextContent("Beispiel AG");
    unmount();
    renderWithIntl(<DashboardView data={empty} />);
    expect(card("Top 5 Kunden").getByText("In diesem Zeitraum sind keine Daten vorhanden.")).toBeInTheDocument();
  });

  test("DASH-009 Verlauf lines with timestamp; hidden when the role may not read the audit log", () => {
    const { unmount } = renderWithIntl(<DashboardView data={full} />);
    const c = card("Verlauf");
    const items = c.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("RE-2026-0001 fertiggestellt");
    expect(items[0]).toHaveTextContent("18.10.2026, 10:05");
    expect(items[0]).toHaveTextContent("Inhaber");
    unmount();
    renderWithIntl(<DashboardView data={{ ...full, activity: null }} />);
    expect(screen.queryByRole("heading", { name: "Verlauf" })).toBeNull();
  });

  test("DASH-010 the to-do slot is rendered as „Aufgaben“", () => {
    renderWithIntl(<DashboardView data={full} todos={<p>Exportieren und versenden: RE-2026-0001</p>} />);
    expect(card("Aufgaben").getByText(/Exportieren und versenden/)).toBeInTheDocument();
  });
});

describe("MOT-003…005 motion on the Übersicht (04-ui-ux §7.1)", () => {
  test("MOT-003 quick-action tiles lift on hover and settle on press", () => {
    renderWithIntl(<DashboardView data={full} />);
    const tile = within(screen.getByRole("navigation", { name: "Schnellaktionen" })).getByRole("link", {
      name: "Rechnung schreiben",
    });
    expect(tile.className).toMatch(/hover:-translate-y-0\.5/);
    expect(tile.className).toMatch(/active:translate-y-0/);
    expect(tile.className).toMatch(/transition-\[/);
  });

  test("MOT-004 the cards rise in one after another", () => {
    renderWithIntl(<DashboardView data={full} />);
    const cards = screen.getAllByRole("region");
    expect(cards.length).toBeGreaterThan(3);
    const delays = cards.map((c) => (c as HTMLElement).style.getPropertyValue("--motion-delay"));
    for (const c of cards) expect(c.className).toMatch(/animate-rise/);
    expect(new Set(delays).size).toBe(cards.length);
  });

  test("MOT-005 chart bars grow from the baseline and the KU bar fills from the left", () => {
    renderWithIntl(<DashboardView data={full} />);
    const chart = screen.getByRole("img", { name: /Einnahmen und Ausgaben/ });
    const bars = chart.querySelectorAll(".animate-grow-y");
    expect(bars.length).toBeGreaterThan(0);
    const indicator = card("Kleinunternehmergrenze")
      .getByRole("progressbar")
      .querySelector("[data-slot=progress-indicator]");
    expect(indicator?.className).toMatch(/animate-grow-x/);
  });
});
