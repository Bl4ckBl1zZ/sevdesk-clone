import { RoleGate } from "@/components/auth/role-gate";
import { catalogMetadata } from "@/components/catalog/catalog-page";
import { RecurringDetail } from "@/components/recurring/recurring-detail";

export const generateMetadata = () => catalogMetadata("wiederkehrend");

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <RoleGate permission="documents.read">
      <RecurringDetail id={id} />
    </RoleGate>
  );
}
