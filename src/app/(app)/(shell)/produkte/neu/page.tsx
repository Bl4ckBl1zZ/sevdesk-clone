import { CatalogPage, catalogMetadata } from "@/components/catalog/catalog-page";
import { ProductForm } from "@/components/products/product-form";

export const generateMetadata = () => catalogMetadata("produkteNeu");

export default function Page() {
  return (
    <CatalogPage page="produkteNeu" parent="produkte" permission="products.write">
      <ProductForm />
    </CatalogPage>
  );
}
