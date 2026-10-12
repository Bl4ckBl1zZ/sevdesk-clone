import {
  type ContactCreateFormValues,
  type ContactFormValues,
  emptyAddress,
  emptyContactForm,
} from "../src/domain/schemas/contacts";
import { emptyProductForm, type ProductFormValues } from "../src/domain/schemas/products";
import { api } from "./_generated/api";
import type { TestT } from "./test.setup";

/** Test fixtures for the contact and product suites (not a Convex module: multi-dot file name). */

export const CONTACT_RANGE = { key: "contact", name: "Kontakte", format: "{#####}", resetPolicy: "never", next: 10000 };
export const PRODUCT_RANGE = { key: "product", name: "Produkte", format: "ART-{#####}", resetPolicy: "never", next: 1 };

/** Owner with the contact and product number ranges (F01 SET-064). */
export async function setupCatalog(t: TestT) {
  const owner = await t.asUser("owner");
  await owner.mutation(api.settings.saveNumberRanges, { values: { ranges: [CONTACT_RANGE, PRODUCT_RANGE] } });
  return owner;
}

export function orgForm(name: string, over: Partial<ContactFormValues> = {}): ContactFormValues {
  return { ...emptyContactForm(), kind: "organization", organizationName: name, roles: ["customer"], ...over };
}

export function personForm(first: string, last: string, over: Partial<ContactFormValues> = {}): ContactFormValues {
  return { ...emptyContactForm(), kind: "person", firstName: first, lastName: last, roles: ["customer"], ...over };
}

export function createValues(
  contact: ContactFormValues,
  opts: {
    address?: Partial<ReturnType<typeof emptyAddress>>;
    email?: string;
    phone?: string;
  } = {},
): ContactCreateFormValues {
  const channels: ContactCreateFormValues["channels"] = [];
  if (opts.email) channels.push({ type: "email", value: opts.email, label: "", isPrimary: true, isInvoiceEmail: true });
  if (opts.phone)
    channels.push({ type: "phone", value: opts.phone, label: "", isPrimary: true, isInvoiceEmail: false });
  return {
    contact,
    billingAddress: { ...emptyAddress(), ...(opts.address ?? {}) },
    channels,
  };
}

export const BERLIN = { street: "Hauptstr. 1", postalCode: "10115", city: "Berlin", countryCode: "DE" };
export const PARIS = { street: "1 Rue de Rivoli", postalCode: "75001", city: "Paris", countryCode: "FR" };

export function productForm(name: string, over: Partial<ProductFormValues> = {}): ProductFormValues {
  return { ...emptyProductForm(), name, price: "95,00", ...over };
}
