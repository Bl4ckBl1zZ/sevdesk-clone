import { CatalogPage, catalogMetadata } from "@/components/catalog/catalog-page";
import { ProductsList } from "@/components/products/products-list";

export const generateMetadata = () => catalogMetadata("produkte");

export default function Page() {
  return (
    <CatalogPage page="produkte" permission="products.read" body={false}>
      <ProductsList />
    </CatalogPage>
  );
}
