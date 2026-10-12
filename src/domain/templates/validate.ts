/**
 * Save-time rules of text templates (F01 SET-080…082): sanitise the body, check the length and the placeholders of
 * body and subject, and keep at most one default per (kind, document type, language).
 */
import { err, issue, ok, type Result } from "../result";
import { type PlaceholderIssue, type TemplateKind, type TemplateScope, validatePlaceholders } from "./placeholders";
import { sanitizeTemplateHtml, validateTemplateBody } from "./sanitize";

export interface TextTemplateInput {
  kind: TemplateKind;
  docTypes: readonly string[];
  language: "de" | "en";
  name: string;
  subject?: string | undefined;
  body: string;
  isDefault: boolean;
}

export interface PreparedTextTemplate extends TextTemplateInput {
  subject: string | undefined;
  placeholders: string[];
}

export function prepareTextTemplate(
  input: TextTemplateInput,
  customFields?: TemplateScope["customFields"],
): Result<PreparedTextTemplate> {
  const body = sanitizeTemplateHtml(input.body);
  const length = validateTemplateBody(body);
  if (!length.ok) return err(issue(length.error.code, length.error.message, { field: "body" }));
  const scope: TemplateScope = {
    kind: input.kind,
    docTypes: input.docTypes,
    ...(customFields ? { customFields } : {}),
  };
  const withField = (e: PlaceholderIssue, field: string) => issue(e.code, e.message, { ...e.params, field });
  const bodyCheck = validatePlaceholders(body, scope);
  if (!bodyCheck.ok) return err(withField(bodyCheck.error, "body"));
  const subject = input.kind === "message_text" ? (input.subject ?? "").trim() || undefined : undefined;
  const placeholders = new Set(bodyCheck.value);
  if (subject) {
    const subjectCheck = validatePlaceholders(subject, scope);
    if (!subjectCheck.ok) return err(withField(subjectCheck.error, "subject"));
    for (const p of subjectCheck.value) placeholders.add(p);
  }
  return ok({ ...input, body, subject, placeholders: [...placeholders] });
}

interface DefaultRef {
  id: string;
  kind: string;
  language: string;
  docTypes: readonly string[];
  isDefault?: boolean;
}

/** SET-080: ids of other default templates that overlap `candidate` (same kind and language, shared doc type). */
export function defaultsToClear(existing: readonly DefaultRef[], candidate: DefaultRef): string[] {
  return existing
    .filter(
      (t) =>
        t.isDefault &&
        t.id !== candidate.id &&
        t.kind === candidate.kind &&
        t.language === candidate.language &&
        t.docTypes.some((d) => candidate.docTypes.includes(d)),
    )
    .map((t) => t.id);
}
