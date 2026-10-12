import { PlaceholderPage, placeholderMetadata } from "@/components/layout/placeholder-page";

export const generateMetadata = () => placeholderMetadata("journal");

export default function Page() {
  return <PlaceholderPage page="journal" />;
}
