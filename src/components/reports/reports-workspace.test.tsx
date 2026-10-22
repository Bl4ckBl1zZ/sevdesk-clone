import { screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { reportMeta } from "@/domain/reports/meta";
import { computeVerprobung } from "@/domain/reports/verprobung";
import { renderWithIntl } from "@/i18n/test-utils";
import { MetaFacts, Tiles, VerprobungResult } from "./reports-workspace";

const meta = (locked: string[]) =>
  reportMeta({
    report: "bwa",
    params: { monat: "2026-03", variante: "accrual" },
    generatedAt: Date.UTC(2026, 3, 2, 8, 0),
    ruleVersions: ["chart-skr04", "bwa-2026.1"],
    from: "2026-01-01",
    to: "2026-03-31",
    lockedMonths: locked,
  });

describe("/auswertungen (F08 §6, RPT-001)", () => {
  test("RPT-001 the overview links every report tile", () => {
    renderWithIntl(<Tiles />);
    expect(screen.getByRole("link", { name: /^BWA/ })).toHaveAttribute("href", "/auswertungen?bericht=bwa");
    expect(screen.getByRole("link", { name: /Summen- und Saldenliste/ })).toHaveAttribute(
      "href",
      "/auswertungen?bericht=susa",
    );
    expect(screen.getByRole("link", { name: /Liquiditätsvorschau/ })).toHaveAttribute(
      "href",
      "/auswertungen/liquiditaet",
    );
    expect(screen.getByRole("link", { name: /Anlagenspiegel/ })).toHaveAttribute("href", "/buchhaltung/anlagen");
    expect(screen.getAllByRole("link")).toHaveLength(9);
  });

  test("RPT-001 TST-RPT-08 an open month shows the „vorläufig“ badge with parameters and rule versions", () => {
    renderWithIntl(<MetaFacts meta={meta(["2026-01", "2026-02"])} />);
    expect(screen.getByRole("status")).toHaveTextContent("vorläufigVorläufig – Zeitraum nicht festgeschrieben.");
    expect(screen.getByText("monat=2026-03, variante=accrual")).toBeInTheDocument();
    expect(screen.getByText("chart-skr04, bwa-2026.1")).toBeInTheDocument();
    expect(screen.getByText("vorläufig (2 von 3 Monaten festgeschrieben)")).toBeInTheDocument();
  });

  test("RPT-001 E-RPT-01 a fully locked range is „festgeschrieben“", () => {
    renderWithIntl(<MetaFacts meta={meta(["2026-01", "2026-02", "2026-03"])} />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getAllByText("festgeschrieben")).toHaveLength(2);
  });
});

describe("/auswertungen?bericht=verprobung (RPT-009)", () => {
  test("RPT-009 the tile opens the report; rows per rate and the document with a difference link to its source", () => {
    const { unmount } = renderWithIntl(<Tiles />);
    expect(screen.getByRole("link", { name: /USt-Verprobung/ })).toHaveAttribute(
      "href",
      "/auswertungen?bericht=verprobung",
    );
    unmount();
    const result = computeVerprobung(
      [
        {
          id: "e1",
          seq: 1,
          date: "2026-05-01",
          source: { kind: "salesDocument", id: "d1" },
          text: "Rechnung RE-1",
          lines: [
            { account: "8400", taxKey: "USt19", debitCents: 0, creditCents: 10000 },
            { account: "1776", role: "vat.output.19", debitCents: 0, creditCents: 1700 },
            { account: "1400", role: "receivable", debitCents: 11700, creditCents: 0 },
          ],
        },
      ],
      { from: "2026-01-01", to: "2026-12-31" },
    );
    const data = {
      meta: reportMeta({
        report: "verprobung",
        params: { from: "2026-01-01", to: "2026-12-31" },
        generatedAt: Date.UTC(2026, 9, 2),
        ruleVersions: [],
        from: "2026-01-01",
        to: "2026-12-31",
        lockedMonths: [],
      }),
      ...result,
      documents: result.documents.map((d) => ({ ...d, href: "/rechnungen/d1" })),
    };
    renderWithIntl(<VerprobungResult data={data} />);
    expect(screen.getByRole("region", { name: "USt-Verprobung je Steuersatz" }).tabIndex).toBe(0);
    expect(screen.getByRole("heading", { name: "1 Beleg mit Differenz" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Rechnung RE-1" })).toHaveAttribute("href", "/rechnungen/d1");
  });
});
