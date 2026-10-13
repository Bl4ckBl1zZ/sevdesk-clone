import { RoleGate } from "@/components/auth/role-gate";
import { BankAccountView } from "@/components/banking/account-view";
import { catalogMetadata } from "@/components/catalog/catalog-page";

export const generateMetadata = () => catalogMetadata("bank");

export default async function Page({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params;
  return (
    <RoleGate permission="banking.read">
      <BankAccountView id={accountId} />
    </RoleGate>
  );
}
