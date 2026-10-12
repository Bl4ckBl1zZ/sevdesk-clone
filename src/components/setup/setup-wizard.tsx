"use client";

import { CheckIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type ComponentType, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { resumeStep, type StepKey, stepHref, stepIndex, WIZARD_STEPS } from "./steps";
import { AccessStep } from "./steps/access-step";
import { DoneStep } from "./steps/done-step";
import { EmailStep } from "./steps/email-step";
import { BankStep, CompanyStep, LayoutStep, NumberRangesStep, TaxStep } from "./steps/form-steps";
import { OwnerStep } from "./steps/owner-step";
import { StartStep } from "./steps/start-step";
import { StorageStep } from "./steps/storage-step";
import { useSetupState } from "./use-setup-state";
import { WizardContext, type WizardDrafts } from "./wizard-context";

const STEP_COMPONENTS: Record<StepKey, ComponentType> = {
  inhaberkonto: OwnerStep,
  zugriff: AccessStep,
  email: EmailStep,
  speicher: StorageStep,
  start: StartStep,
  unternehmen: CompanyStep,
  steuern: TaxStep,
  bank: BankStep,
  layout: LayoutStep,
  nummernkreise: NumberRangesStep,
  fertig: DoneStep,
};

const FORM_ID = "einrichtung-schritt";
const TOTAL_STEPS = WIZARD_STEPS.length;

/**
 * Setup wizard (F01 §3.1, §6.2; 04-ui-ux §4.8). Desktop: vertical stepper + centred card (max 720 px).
 * Phone: progress bar on top and a sticky bottom action bar [Zurück] [Weiter].
 */
export function SetupWizard({ stepSlug }: { stepSlug: string | null }) {
  const t = useTranslations("setup");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const state = useSetupState() ?? null;
  const [drafts, setDrafts] = useState<WizardDrafts>({});
  const [nextDisabled, setNextDisabled] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);

  const index = useMemo(() => {
    const i = stepIndex(stepSlug);
    return i >= 0 ? i : WIZARD_STEPS.indexOf(resumeStep(state?.completedSteps ?? []));
  }, [stepSlug, state]);
  const step = WIZARD_STEPS[index] ?? WIZARD_STEPS[0];
  const completed = new Set(state?.completedSteps ?? []);
  const total = TOTAL_STEPS;

  const goTo = useCallback(
    (i: number) => {
      const target = WIZARD_STEPS[Math.max(0, Math.min(TOTAL_STEPS - 1, i))];
      if (target) router.push(stepHref(target) as Route, { scroll: true });
    },
    [router],
  );
  const next = useCallback(() => goTo(index + 1), [goTo, index]);

  // Move focus to the step heading after a step change (04-ui-ux §7).
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on step change only
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [index]);

  if (!step) return null;
  // Without an explicit step the wizard waits for the server state to resume at the right step (SET-003).
  if (!state && stepIndex(stepSlug) < 0) return <div className="mx-auto h-96 w-full max-w-5xl" aria-busy="true" />;
  const StepComponent = STEP_COMPONENTS[step.key];
  const isLast = index === total - 1;

  return (
    <WizardContext.Provider value={{ formId: FORM_ID, state, drafts, setDrafts, next, setNextDisabled }}>
      <div className="mx-auto flex w-full max-w-5xl gap-8 px-4 pt-4 pb-28 md:pb-10 lg:pt-10">
        <nav aria-label={t("stepsLabel")} className="hidden w-56 shrink-0 lg:block">
          <ol className="flex flex-col gap-1">
            {WIZARD_STEPS.map((s, i) => {
              const current = i === index;
              const done = completed.has(s.key);
              return (
                <li key={s.slug}>
                  <Link
                    href={stepHref(s) as Route}
                    aria-current={current ? "step" : undefined}
                    className={cn(
                      "flex items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-muted",
                      current ? "bg-muted font-medium" : "text-muted-foreground",
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs",
                        done && "border-success bg-success text-background",
                        current && !done && "border-primary text-foreground",
                      )}
                    >
                      {done ? <CheckIcon className="size-3.5" /> : i + 1}
                    </span>
                    <span>{t(`steps.${s.key}`)}</span>
                    <span className="sr-only">
                      ({done ? t("stepState.done") : current ? t("stepState.current") : t("stepState.pending")})
                    </span>
                  </Link>
                </li>
              );
            })}
          </ol>
          <Link href="/" className="mt-4 block px-2 text-muted-foreground text-sm underline underline-offset-4">
            {t("resumeLater")}
          </Link>
        </nav>

        <div className="flex w-full min-w-0 max-w-[720px] flex-col gap-4">
          <Progress value={Math.round(((index + 1) / total) * 100)} className="lg:hidden">
            <ProgressLabel>{t("progress", { current: index + 1, total })}</ProgressLabel>
            <ProgressValue />
          </Progress>
          <Card key={state ? "loaded" : "loading"}>
            <CardHeader>
              <p className="text-muted-foreground text-xs uppercase tracking-wide">
                {t("title")} · {t("progress", { current: index + 1, total })}
              </p>
              <h1 ref={headingRef} tabIndex={-1} className="font-semibold text-xl outline-none">
                {t(`steps.${step.key}`)}
              </h1>
              <CardDescription>{t(`stepDescriptions.${step.key}`)}</CardDescription>
            </CardHeader>
            <CardContent>
              <StepComponent key={step.key} />
            </CardContent>
          </Card>

          <div className="fixed inset-x-0 bottom-0 z-30 flex gap-2 border-t bg-background p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:static md:justify-end md:border-0 md:bg-transparent md:p-0">
            {index > 0 && (
              <Button
                type="button"
                variant="outline"
                className="h-11 flex-1 md:h-9 md:flex-none"
                onClick={() => goTo(index - 1)}
              >
                {tCommon("back")}
              </Button>
            )}
            {step.skippable && (
              <Button type="button" variant="ghost" className="h-11 flex-1 md:h-9 md:flex-none" onClick={next}>
                {t("skip")}
              </Button>
            )}
            {!isLast && (
              <Button type="submit" form={FORM_ID} className="h-11 flex-1 md:h-9 md:flex-none" disabled={nextDisabled}>
                {tCommon("next")}
              </Button>
            )}
          </div>
        </div>
      </div>
    </WizardContext.Provider>
  );
}
