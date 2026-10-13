import { RoleGate } from "@/components/auth/role-gate";
import { catalogMetadata } from "@/components/catalog/catalog-page";
import { InvoiceDetail } from "@/components/invoices/invoice-detail";

export const generateMetadata = () => catalogMetadata("lieferscheine");

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <RoleGate permission="documents.read">
      <InvoiceDetail id={id} />
    </RoleGate>
  );
}
