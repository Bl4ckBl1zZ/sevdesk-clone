import { AccountingPage, accountingMetadata } from "@/components/accounting/accounting-page";
import { ManualEntryEditor } from "@/components/accounting/manual-entry-editor";
import { requireRole } from "@/lib/auth-server";

export const generateMetadata = () => accountingMetadata("journalNeu");
export const dynamic = "force-dynamic";

/** /buchhaltung/journal/neu (F08 §6, ACC-011): manual journal entry editor (owner, bookkeeper). */
export default function Page() {
  return (
    <AccountingPage page="journalNeu">
      <Content />
    </AccountingPage>
  );
}

async function Content() {
  await requireRole("accounting.write");
  return <ManualEntryEditor />;
}
