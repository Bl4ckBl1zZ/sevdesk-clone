import { RoleGate } from "@/components/auth/role-gate";
import { catalogMetadata } from "@/components/catalog/catalog-page";
import { VatEvidence } from "@/components/contacts/vat-evidence";

export const generateMetadata = () => catalogMetadata("kontakte");

export default async function Page({ params }: { params: Promise<{ id: string; checkId: string }> }) {
  const { id, checkId } = await params;
  return (
    <RoleGate permission="contacts.read">
      <VatEvidence contactId={id} checkId={checkId} />
    </RoleGate>
  );
}
