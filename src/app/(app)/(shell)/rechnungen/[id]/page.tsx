import { RoleGate } from "@/components/auth/role-gate";
import { catalogMetadata } from "@/components/catalog/catalog-page";
import { InvoiceDetail } from "@/components/invoices/invoice-detail";

export const generateMetadata = () => catalogMetadata("rechnungen");

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ fertigstellen?: string | string[] }>;
}) {
  const { id } = await params;
  const { fertigstellen } = await searchParams;
  return (
    <RoleGate permission="documents.read">
      <InvoiceDetail id={id} askFinalize={fertigstellen === "1"} />
    </RoleGate>
  );
}
