import { NoPosNotice } from "@/components/layout/no-pos-notice";
import { PlaceholderPage, placeholderMetadata } from "@/components/layout/placeholder-page";

export const generateMetadata = () => placeholderMetadata("kasse");

export default function Page() {
  return <PlaceholderPage page="kasse" notice={<NoPosNotice />} />;
}
