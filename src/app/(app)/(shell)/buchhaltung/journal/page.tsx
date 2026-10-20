import { AccountingPage, accountingMetadata } from "@/components/accounting/accounting-page";
import { JournalViewer } from "@/components/accounting/journal-viewer";
import { canDo } from "@/domain/access/permissions";
import { requireRole } from "@/lib/auth-server";

export const generateMetadata = () => accountingMetadata("journal");
export const dynamic = "force-dynamic";

/** /buchhaltung/journal (F08 §6; ACC-001/ACC-003/ACC-025, RPT-008): journal search, Buchungsjournal, Gegenbuchung. */
export default function Page() {
  return (
    <AccountingPage page="journal">
      <Content />
    </AccountingPage>
  );
}

async function Content() {
  const me = await requireRole("accounting.read");
  return <JournalViewer canWrite={canDo(me.role, "accounting.write")} />;
}
