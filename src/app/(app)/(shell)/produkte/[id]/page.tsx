import { RoleGate } from "@/components/auth/role-gate";
import { catalogMetadata } from "@/components/catalog/catalog-page";
import { ProductDetail } from "@/components/products/product-detail";

export const generateMetadata = () => catalogMetadata("produkte");

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <RoleGate permission="products.read">
      <ProductDetail id={id} />
    </RoleGate>
  );
}
