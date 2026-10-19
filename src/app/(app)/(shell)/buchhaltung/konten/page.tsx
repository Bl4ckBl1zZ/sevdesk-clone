import { AccountingPage, accountingMetadata } from "@/components/accounting/accounting-page";
import { ChartOfAccounts } from "@/components/accounting/chart-of-accounts";
import { canDo } from "@/domain/access/permissions";
import { requireRole } from "@/lib/auth-server";

export const generateMetadata = () => accountingMetadata("konten");
export const dynamic = "force-dynamic";

/** /buchhaltung/konten (F08 §6, ACC-007/ACC-008/ACC-009): chart of accounts, custom accounts, „Rollen & Standardkonten“. */
export default function Page() {
  return (
    <AccountingPage page="konten">
      <Content />
    </AccountingPage>
  );
}

async function Content() {
  const me = await requireRole("accounting.read");
  return <ChartOfAccounts isOwner={canDo(me.role, "accounting.roles")} canWrite={canDo(me.role, "accounting.write")} />;
}
