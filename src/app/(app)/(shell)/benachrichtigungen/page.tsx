import { CatalogPage, catalogMetadata } from "@/components/catalog/catalog-page";
import { NotificationCenter } from "@/components/notifications/notification-center";

export const generateMetadata = () => catalogMetadata("benachrichtigungen");

/** F12 §6 Bell / `/benachrichtigungen` (NTF-001). */
export default function Page() {
  return (
    <CatalogPage page="benachrichtigungen" permission="notifications.read">
      <NotificationCenter />
    </CatalogPage>
  );
}
