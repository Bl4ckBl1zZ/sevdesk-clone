import { AccountingPage, accountingMetadata } from "@/components/accounting/accounting-page";
import { JournalViewer } from "@/components/accounting/journal-viewer";

export const generateMetadata = () => accountingMetadata("journal");

/** /buchhaltung/journal (F08 §6, ACC-001/ACC-003): read-only journal viewer. */
export default function Page() {
  return (
    <AccountingPage page="journal">
      <JournalViewer />
    </AccountingPage>
  );
}
