"use client";

import { useEffect, useState } from "react";
import { OtpForm } from "./otp-form";
import { readPendingEmail } from "./pending-email";

/** Reads the address stored by `/anmelden` (client only, avoids a hydration mismatch). */
export function OtpStep({ redirectTo }: { redirectTo?: string | null }) {
  const [email, setEmail] = useState<string | null | undefined>(undefined);
  useEffect(() => setEmail(readPendingEmail()), []);
  if (email === undefined) return <div className="h-72" aria-hidden="true" />;
  return <OtpForm email={email} redirectTo={redirectTo} />;
}
