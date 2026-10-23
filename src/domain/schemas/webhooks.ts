import { z } from "zod";

/**
 * Webhook endpoint form (05 §5.1), shared by Einstellungen › Webhooks, REST `/webhook-endpoints` and Convex. The URL
 * policy (HTTPS in production, SSRF guard) and the event list are checked authoritatively in the model
 * (src/domain/webhooks/url.ts, events.ts).
 */
export const webhookEndpointCreateSchema = z.object({
  url: z.string().trim().min(1, "Bitte eine URL angeben.").max(2000),
  description: z.string().trim().max(500).optional(),
  events: z.array(z.string()).min(1, "Bitte mindestens ein Ereignis oder „Alle Ereignisse“ wählen."),
  enabled: z.boolean().default(true),
});
export type WebhookEndpointCreate = z.output<typeof webhookEndpointCreateSchema>;

export const webhookEndpointUpdateSchema = z.object({
  url: z.string().trim().min(1).max(2000).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  events: z.array(z.string()).min(1).optional(),
  enabled: z.boolean().optional(),
});
export type WebhookEndpointUpdate = z.output<typeof webhookEndpointUpdateSchema>;
