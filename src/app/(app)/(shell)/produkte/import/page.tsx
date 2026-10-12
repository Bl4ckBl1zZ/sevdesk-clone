import { CatalogPage, catalogMetadata } from "@/components/catalog/catalog-page";
import { ProductImport } from "@/components/products/product-import";

export const generateMetadata = () => catalogMetadata("produkteImport");

export default function Page() {
  return (
    <CatalogPage page="produkteImport" parent="produkte" permission="products.write">
      <ProductImport />
    </CatalogPage>
  );
}
