import { CatalogPage, catalogMetadata } from "@/components/catalog/catalog-page";
import { CategoriesPanel } from "@/components/products/categories-panel";

export const generateMetadata = () => catalogMetadata("produkteKategorien");

export default function Page() {
  return (
    <CatalogPage page="produkteKategorien" parent="produkte" permission="products.read">
      <CategoriesPanel />
    </CatalogPage>
  );
}
