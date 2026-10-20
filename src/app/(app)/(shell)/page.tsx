import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Dashboard } from "@/components/dashboard/dashboard";
import { TodosWidget } from "@/components/invoices/invoices-list";
import { UnbilledTimeWidget } from "@/components/time/unbilled-widget";
import { VoucherTodosWidget } from "@/components/vouchers/voucher-todos";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages.start");
  return { title: t("title") };
}

/**
 * Übersicht (04-ui-ux §4.7, sevdesk layout): greeting, quick actions, „Gewinn vor Steuern“ and the widget grid. The
 * to-dos (SND-21, REC-16) stay as the „Aufgaben“ card at the end of the grid.
 */
export default function StartPage() {
  return (
    <Dashboard
      todos={
        <>
          <TodosWidget />
          <VoucherTodosWidget />
          <UnbilledTimeWidget />
        </>
      }
    />
  );
}
