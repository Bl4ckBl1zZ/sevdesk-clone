import { seedPaymentMethods, seedUnits } from "./lookups";
import { seedTextTemplates } from "./textTemplates";
import type { ModelCtx } from "./types";

/**
 * Seeded settings data (F01 SET-086, SET-090, SET-092) inserted when the setup is completed. Each seed is idempotent
 * and only fills gaps, so it can run again („Standardwerte wiederherstellen“) without touching owner changes.
 */
export async function seedSettingsDefaults(ctx: ModelCtx): Promise<void> {
  await seedTextTemplates(ctx);
  await seedUnits(ctx);
  await seedPaymentMethods(ctx);
}
