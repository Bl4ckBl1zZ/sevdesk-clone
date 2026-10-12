import { RoleGate } from "@/components/auth/role-gate";
import { catalogMetadata } from "@/components/catalog/catalog-page";
import { ContactDetail } from "@/components/contacts/contact-detail";

export const generateMetadata = () => catalogMetadata("kontakte");

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <RoleGate permission="contacts.read">
      <ContactDetail id={id} />
    </RoleGate>
  );
}
