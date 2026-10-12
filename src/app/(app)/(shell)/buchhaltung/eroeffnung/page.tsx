import { AccountingPage, accountingMetadata } from "@/components/accounting/accounting-page";
import { OpeningBalanceWizard } from "@/components/accounting/opening-balance-wizard";
import { canDo } from "@/domain/access/permissions";
import { requireRole } from "@/lib/auth-server";

export const generateMetadata = () => accountingMetadata("eroeffnung");
export const dynamic = "force-dynamic";

/** /buchhaltung/eroeffnung (F08 §6, ACC-013/ACC-014): Buchungsbeginn and opening balances. */
export default function Page() {
  return (
    <AccountingPage page="eroeffnung">
      <Content />
    </AccountingPage>
  );
}

async function Content() {
  const me = await requireRole("accounting.read");
  return (
    <OpeningBalanceWizard
      canPost={canDo(me.role, "accounting.openingBalance")}
      isOwner={canDo(me.role, "settings.ownerOnly")}
    />
  );
}
