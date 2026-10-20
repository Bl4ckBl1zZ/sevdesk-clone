import { screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { reportMeta } from "@/domain/reports/meta";
import { renderWithIntl } from "@/i18n/test-utils";
import { MetaFacts, Tiles } from "./reports-workspace";

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
