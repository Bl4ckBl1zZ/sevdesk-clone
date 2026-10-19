import { AccountingPage, accountingMetadata } from "@/components/accounting/accounting-page";
import { AssetRegister } from "@/components/accounting/asset-register";
import { canDo } from "@/domain/access/permissions";
import { requireRole } from "@/lib/auth-server";

export const generateMetadata = () => accountingMetadata("anlagen");
export const dynamic = "force-dynamic";

/** /buchhaltung/anlagen (F08 §6, AST-001…AST-012): asset register, AfA, disposal, Anlagenspiegel, GWG, Sammelposten. */
export default function Page() {
  return (
    <AccountingPage page="anlagen">
      <Content />
    </AccountingPage>
  );
}

async function Content() {
  const me = await requireRole("accounting.read");
  return <AssetRegister canWrite={canDo(me.role, "assets.write")} />;
}
