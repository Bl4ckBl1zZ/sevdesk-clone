import { RoleGate } from "@/components/auth/role-gate";
import { catalogMetadata } from "@/components/catalog/catalog-page";
import { VoucherDetail } from "@/components/vouchers/voucher-detail";

export const generateMetadata = () => catalogMetadata("belege");

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <RoleGate permission="vouchers.read">
      <VoucherDetail id={id} />
    </RoleGate>
  );
}
