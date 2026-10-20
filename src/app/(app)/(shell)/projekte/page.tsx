import { CatalogPage, catalogMetadata } from "@/components/catalog/catalog-page";
import { ProjectsList } from "@/components/projects/projects-list";

export const generateMetadata = () => catalogMetadata("projekte");

export default function Page() {
  return (
    <CatalogPage page="projekte" permission="projects.read" body={false}>
      <ProjectsList />
    </CatalogPage>
  );
}
