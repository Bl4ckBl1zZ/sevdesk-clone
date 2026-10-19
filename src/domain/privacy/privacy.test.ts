import { describe, expect, test } from "vitest";
import { art30Markdown, art30Record } from "./art30";
import { configuredServices, EXTERNAL_SERVICES, nonEuWarning, regionOfEndpoint } from "./external-services";

describe("external services (PRV-016, SET-048, SET-109, SET-114)", () => {
  test("PRV-016 the shipped catalog lists the processors and public authorities with role, data, region and DPA", () => {
    const ids = EXTERNAL_SERVICES.map((s) => s.id);
    for (const id of [
      "enable_banking",
      "cloudflare_email",
      "cloudflare_r2",
      "tailscale",
      "claude",
      "ntfy",
      "evatr",
      "vies",
      "lets_encrypt",
    ]) {
      expect(ids).toContain(id);
    }
    for (const s of EXTERNAL_SERVICES) {
      expect(s.purpose.length).toBeGreaterThan(5);
      expect(s.dataCategories.length).toBeGreaterThan(5);
      if (s.role === "processor" && s.id !== "ntfy") expect(s.dpaUrl).toMatch(/^https:\/\//);
    }
    expect(EXTERNAL_SERVICES.find((s) => s.id === "evatr")?.role).toBe("public_authority");
  });

  test("SET-048 endpoints are classified by declared region or the bundled host table", () => {
    expect(regionOfEndpoint("https://acc.eu.r2.cloudflarestorage.com/bucket")).toBe("EU");
    expect(regionOfEndpoint("https://acc.r2.cloudflarestorage.com/bucket")).toBe("global");
    expect(regionOfEndpoint("https://api.anthropic.com/v1")).toBe("US");
    expect(regionOfEndpoint("https://ntfy.sh")).toBe("unknown");
    expect(regionOfEndpoint("http://ntfy.tail1234.ts.net")).toBe("self_hosted");
    expect(regionOfEndpoint("https://example.org", "eu")).toBe("EU");
    expect(regionOfEndpoint("kein url")).toBe("unknown");
  });

  test("SET-109 SET-114 E-AUD-24 non-EU processors without AVV warn (Cloudflare Email: warning only); authorities never", () => {
    const list = configuredServices({
      inUse: [
        { id: "cloudflare_email" },
        { id: "cloudflare_r2", region: "EU" },
        { id: "evatr" },
        { id: "ntfy", region: "unknown" },
      ],
      avv: { cloudflare_r2: Date.UTC(2026, 9, 1) },
    });
    const byId = Object.fromEntries(list.map((s) => [s.id, s]));
    expect(byId.cloudflare_email).toMatchObject({
      avvMissing: true,
      warning: nonEuWarning("Cloudflare Email Sending"),
    });
    expect(nonEuWarning("Cloudflare Email Sending")).toBe(
      "Cloudflare Email Sending verarbeitet Daten außerhalb der EU. Auftragsverarbeitungsvertrag und § 146 Abs. 2 AO beachten.",
    );
    expect(byId.cloudflare_r2).toMatchObject({ avvMissing: false, warning: null, effectiveRegion: "EU" });
    expect(byId.evatr).toMatchObject({ avvMissing: false, warning: null });
    expect(byId.ntfy?.warning).not.toBeNull();
    const confirmed = configuredServices({ inUse: [{ id: "cloudflare_email" }], avv: { cloudflare_email: 1 } });
    expect(confirmed[0]?.warning).toBeNull();
  });
});

describe("Art. 30 record (DSGVO-01, PRV-015)", () => {
  test("DSGVO-01 PRV-015 the template names controller, activities, recipients from the services, transfers and TOMs", () => {
    const services = configuredServices({
      inUse: [{ id: "cloudflare_email" }, { id: "cloudflare_r2", region: "EU" }, { id: "evatr" }, { id: "tailscale" }],
      avv: { cloudflare_r2: 1 },
    });
    const r = art30Record({
      controller: { name: "Muster Consulting", address: "Markt 1, 52062 Aachen", email: "info@muster.de" },
      services,
      today: "19.10.2026",
    });
    expect(r.title).toBe("Verzeichnis von Verarbeitungstätigkeiten (Art. 30 Abs. 1 DSGVO)");
    expect(r.activities.map((a) => a.name)).toContain("Rechnungsstellung und Angebote");
    const login = r.activities.find((a) => a.name.startsWith("Benutzerkonten"));
    expect(login?.recipients).toContain("Cloudflare Email Sending (Auftragsverarbeiter, Weltweit (inkl. USA))");
    expect(login?.thirdCountry).toContain("Cloudflare Email Sending: AVV fehlt");
    expect(r.activities.find((a) => a.name === "USt-IdNr.-Prüfung")?.recipients).toContain("Behörde");
    expect(r.activities.some((a) => a.name.startsWith("Beleg-Erkennung"))).toBe(false);
    const md = art30Markdown(r);
    expect(md).toContain("## Verantwortlicher");
    expect(md).toContain("Muster Consulting, Markt 1, 52062 Aachen, info@muster.de");
    expect(md).toContain("- Löschfrist: Buchungsbelege (8 Jahre)");
  });
});
