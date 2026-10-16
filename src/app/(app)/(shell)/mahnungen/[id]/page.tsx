import { RoleGate } from "@/components/auth/role-gate";
import { catalogMetadata } from "@/components/catalog/catalog-page";
import { ReminderDetail } from "@/components/dunning/reminder-detail";

export const generateMetadata = () => catalogMetadata("mahnungen");

/** Reminder editor / detail (F05 §6.5). */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <RoleGate permission="documents.read">
      <ReminderDetail id={id} />
    </RoleGate>
  );
}
