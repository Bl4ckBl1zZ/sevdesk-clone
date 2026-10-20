import { AccountingPage, accountingMetadata } from "@/components/accounting/accounting-page";
import { PeriodLockGrid } from "@/components/accounting/period-lock-grid";
import { canDo } from "@/domain/access/permissions";
import { requireRole } from "@/lib/auth-server";

export const generateMetadata = () => accountingMetadata("festschreibung");
export const dynamic = "force-dynamic";

/** /buchhaltung/festschreibung (F08 §6, ACC-015…ACC-017): month grid, checklist, irreversible lock. */
export default function Page() {
  return (
    <AccountingPage page="festschreibung">
      <Content />
    </AccountingPage>
  );
}

async function Content() {
  const me = await requireRole("accounting.read");
  return <PeriodLockGrid canLock={canDo(me.role, "accounting.lock")} />;
}
