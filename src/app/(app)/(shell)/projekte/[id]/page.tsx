import { RoleGate } from "@/components/auth/role-gate";
import { catalogMetadata } from "@/components/catalog/catalog-page";
import { ProjectDetail } from "@/components/projects/project-detail";

export const generateMetadata = () => catalogMetadata("projekte");

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <RoleGate permission="projects.read">
      <ProjectDetail id={id} />
    </RoleGate>
  );
}
