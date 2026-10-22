import { getTranslations } from "next-intl/server";
import { CatalogPage, catalogMetadata } from "@/components/catalog/catalog-page";
import { NewInvoice } from "@/components/invoices/new-invoice";

export const generateMetadata = () => catalogMetadata("rechnungenNeu");

/** „Neue Rechnung“; `?typ=proforma` opens the editor for a Proforma-Rechnung (QUO-12), `?kontakt=` the customer. */
export default async function Page({ searchParams }: { searchParams: Promise<{ kontakt?: string; typ?: string }> }) {
  const { kontakt, typ } = await searchParams;
  // F04 §4.9: `?typ=gutschrift&kontakt=` from the supplier contact opens a self-billing Gutschrift.
  if (typ === "gutschrift") {
    const t = await getTranslations("selfBilling");
    return (
      <CatalogPage
        page="rechnungenNeu"
        parent="rechnungen"
        permission="documents.write"
        title={t("newTitle")}
        description={t("newDescription")}
      >
        <NewInvoice type="self_billing" {...(kontakt ? { contactId: kontakt } : {})} />
      </CatalogPage>
    );
  }
  const proforma = typ === "proforma";
  return (
    <CatalogPage page={proforma ? "proformaNeu" : "rechnungenNeu"} parent="rechnungen" permission="documents.write">
      <NewInvoice type={proforma ? "proforma" : "invoice"} {...(kontakt ? { contactId: kontakt } : {})} />
    </CatalogPage>
  );
}
