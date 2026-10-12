import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { contactSchema } from "@/domain/schemas/contacts";
import { renderWithIntl } from "@/i18n/test-utils";
import { ContactForm, formFromContact } from "./contact-form";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  mutations: {} as Record<string, ReturnType<typeof vi.fn>>,
}));
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown, _args: unknown, enabled = true) =>
    enabled ? backend.data[getFunctionName(ref as never)] : undefined,
}));
vi.mock("convex/react", () => ({
  useMutation: (ref: unknown) => {
    const name = getFunctionName(ref as never);
    backend.mutations[name] ??= vi.fn().mockResolvedValue({ id: "c1", number: "10000", warnings: [] });
    return backend.mutations[name];
  },
}));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

beforeEach(() => {
  backend.mutations = {};
  router.push.mockReset();
  toast.success.mockReset();
  backend.data = {
    "contacts:nextNumber": "10000",
    "contacts:options": [],
    "contacts:duplicateHints": [],
    "lookups:listPaymentMethods": [],
    "lookups:listTags": [],
    "lookups:listCustomFields": [],
  };
});

describe("contact form (F02 §6.4)", () => {
  test("CON-003 an empty number shows the automatic preview", () => {
    renderWithIntl(<ContactForm />);
    expect(screen.getByText("Leer lassen: wird automatisch vergeben (10000).")).toBeInTheDocument();
  });

  test("CON-001 creating an organisation sends the form to contacts:create and opens the new contact", async () => {
    renderWithIntl(<ContactForm />);
    await userEvent.type(screen.getByLabelText(/^Firma/), "Muster GmbH");
    await userEvent.type(screen.getByLabelText("Straße und Hausnummer"), "Hauptstr. 1");
    await userEvent.type(screen.getByLabelText("PLZ"), "10115");
    await userEvent.type(screen.getByLabelText("Ort"), "Berlin");
    await userEvent.type(screen.getByLabelText("E-Mail"), "rechnung@muster.de");
    await userEvent.click(screen.getByRole("button", { name: "Kontakt anlegen" }));
    const create = backend.mutations["contacts:create"];
    expect(create).toHaveBeenCalledOnce();
    const { values } = (create?.mock.calls[0]?.[0] ?? {}) as {
      values: {
        contact: { organizationName: string };
        billingAddress: { city: string };
        channels: { value: string }[];
      };
    };
    expect(values.contact.organizationName).toBe("Muster GmbH");
    expect(values.billingAddress.city).toBe("Berlin");
    expect(values.channels[0]?.value).toBe("rechnung@muster.de");
    expect(toast.success).toHaveBeenCalledWith("Kontakt 10000 angelegt.");
    expect(router.push).toHaveBeenCalledWith("/kontakte/c1");
  });

  test("CON-001 a person needs a last name (validated before sending)", async () => {
    renderWithIntl(<ContactForm />);
    await userEvent.click(screen.getByLabelText("Person"));
    await userEvent.click(screen.getByRole("button", { name: "Kontakt anlegen" }));
    expect(backend.mutations["contacts:create"]).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/^Nachname/)).toHaveAttribute("aria-invalid", "true");
  });

  test("CON-130 duplicate hints appear while typing and do not block saving", async () => {
    backend.data["contacts:duplicateHints"] = [
      { id: "c9", displayName: "Muster GmbH", number: "10004", reasons: ["vatId"] },
    ];
    renderWithIntl(<ContactForm />);
    await userEvent.type(screen.getByLabelText(/^Firma/), "Muster GmbH");
    expect(await screen.findByText("Möglicherweise doppelt:")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Öffnen" })).toHaveAttribute("href", "/kontakte/c9");
    expect(screen.getByRole("button", { name: "Kontakt anlegen" })).toBeEnabled();
  });

  test("CON-044 the Stammdaten of a stored contact round-trip through the shared schema", () => {
    const stored = {
      _id: "c1",
      _creationTime: 0,
      kind: "organization",
      organizationName: "Muster GmbH",
      number: "10000",
      numberNormalized: "10000",
      displayName: "Muster GmbH",
      searchText: "muster gmbh",
      roles: ["customer", "supplier"],
      status: "active",
      isConsumer: false,
      isPublicAuthority: false,
      vatId: "FR40303265045",
      defaultTaxCase: "eu_b2b_service",
      einvoice: { preferredFormat: "xrechnung_cii", pdfConsents: [] },
      language: "de",
      currency: "EUR",
      paymentTerms: { dueDays: 30, skontoPercentBp: 200, skontoDays: 10 },
      defaultDiscountBp: 550,
      reverseCharge13bCertificates: [],
      tags: [],
      customFields: {},
      version: 3,
    };
    const parsed = contactSchema.parse(formFromContact(stored as never));
    expect(parsed).toMatchObject({
      organizationName: "Muster GmbH",
      roles: ["customer", "supplier"],
      vatId: "FR40303265045",
      defaultTaxCase: "eu_b2b_service",
      paymentTerms: { dueDays: 30, skontoPercentBp: 200, skontoDays: 10 },
      defaultDiscountBp: 550,
    });
  });
});
