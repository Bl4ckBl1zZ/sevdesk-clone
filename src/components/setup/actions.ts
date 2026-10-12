/**
 * Adapter between the setup wizard / settings pages and the backend.
 *
 * TODO(convex): every function below is a stub that throws NotConnectedError ("Noch nicht verbunden"). Wire them
 * to the Convex functions of F01 once they exist (public functions via convex/functions.ts wrappers, owner-only,
 * audited — SET-140/142). Nothing here pretends to save. Input shapes are the parsed outputs of ./schema.ts.
 */
import { NotConnectedError } from "@/components/not-connected";
import type {
  AccessValues,
  BankValues,
  CompanyValues,
  EmailStepValues,
  LayoutValues,
  NumberRangesValues,
  TaxValues,
} from "./schema";
import type { StepKey } from "./steps";

export type CheckStatus = "ok" | "warning" | "error" | "unknown";

export interface StatusCheck {
  id: string;
  label: string;
  status: CheckStatus;
  /** German result or remedy text. */
  detail?: string;
}

export interface SetupState {
  /** Derived from data on the server (SET-003): e.g. owner has ≥ 1 passkey → "inhaberkonto". */
  completedSteps: StepKey[];
  ownerEmail: string;
  access: { baseDomain: string; hosts: string[]; checks: StatusCheck[]; values?: Partial<AccessValues> };
  email: {
    sender: string;
    accountId: string;
    tokenConfigured: boolean;
    lastDelivery?: StatusCheck;
    notificationEmail: string;
  };
  storage: { checks: StatusCheck[] };
  company?: Partial<CompanyValues>;
  tax?: Partial<TaxValues>;
  bank?: Partial<BankValues>;
  layout?: Partial<LayoutValues>;
  numberRanges?: NumberRangesValues["ranges"];
  setupCompletedAt?: number;
}

export interface ChecklistItem {
  code: string;
  /** German message from validateCompanyForDocuments (SET-004/012). */
  message: string;
  /** Wizard step or settings page that fixes the item (04-ui-ux §1.5). */
  href: string;
}

export interface SetupChecklist {
  blocking: ChecklistItem[];
  warnings: ChecklistItem[];
}

/** Query: wizard progress and read-only status (SET-003, SET-007, SET-009a, SET-009b). */
export async function getSetupState(): Promise<SetupState> {
  throw new NotConnectedError("setup.getState");
}

/** Step 2: server location + access concept (SET-007, SET-046). */
export async function saveAccessConcept(_input: AccessValues): Promise<void> {
  throw new NotConnectedError("settings.saveAccessConcept");
}

/** Step 2: live host checks (DNS, certificate, `api.` 404 for UI paths, basic auth on `convex-dash.`, RP ID). */
export async function runAccessChecks(): Promise<StatusCheck[]> {
  throw new NotConnectedError("system.runAccessChecks");
}

/** Step 3: owner notification address (default OWNER_EMAIL). */
export async function saveNotificationEmail(_input: EmailStepValues): Promise<void> {
  throw new NotConnectedError("settings.saveNotificationEmail");
}

/** Step 3: "Test-Code senden" via Cloudflare Email Sending (SET-107, errors mapped per §5.9). */
export async function sendTestAuthMail(): Promise<StatusCheck> {
  throw new NotConnectedError("authMail.sendTest");
}

/** Step 4: R2 checkpoint bucket probe write/read/delete + bucket lock + latest backup (SET-009b, SET-115). */
export async function testCheckpointStorage(): Promise<StatusCheck[]> {
  throw new NotConnectedError("integrations.testCheckpointStorage");
}

/** Step 6 / Einstellungen › Unternehmen (SET-010, SET-015). Creates a new companyProfile version. */
export async function saveCompanyProfile(_input: CompanyValues): Promise<void> {
  throw new NotConnectedError("settings.saveCompanyProfile");
}

/**
 * Step 7 / Einstellungen › Steuern (SET-030…044). `priorYearTurnover` is the raw German amount string; the
 * server (or the caller, once available) converts it with src/domain/money to `priorYearTotalTurnoverCents`.
 */
export async function saveTaxSettings(_input: TaxValues): Promise<void> {
  throw new NotConnectedError("settings.saveTaxSettings");
}

/** Step 8 / Einstellungen › Bank: manual (`import`) invoice account (SET-050…053). */
export async function saveBankAccount(_input: BankValues): Promise<void> {
  throw new NotConnectedError("bankAccounts.saveManual");
}

/** Step 9: default layout (new layoutVersion, SET-070/071); `logo` is uploaded via storage first (SET-018). */
export async function saveLayout(_input: LayoutValues & { logo?: File | null }): Promise<void> {
  throw new NotConnectedError("layouts.saveDefault");
}

/** Step 10 / Einstellungen › Nummernkreise: formats and next values (SET-006, SET-055…060). */
export async function saveNumberRanges(_input: NumberRangesValues): Promise<void> {
  throw new NotConnectedError("numberRanges.saveMany");
}

/** Step 11: checklist from validateCompanyForDocuments (SET-004). */
export async function getSetupChecklist(): Promise<SetupChecklist> {
  throw new NotConnectedError("setup.checklist");
}

/** Step 11: sets setupCompletedAt + audit entry; refused while blocking items exist (SET-004). */
export async function completeSetup(): Promise<void> {
  throw new NotConnectedError("setup.complete");
}
