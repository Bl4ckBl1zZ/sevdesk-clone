import { PlaceholderPage, placeholderMetadata } from "@/components/layout/placeholder-page";

export const generateMetadata = () => placeholderMetadata("bank");

export default function Page() {
  return <PlaceholderPage page="bank" />;
}
