import Image from "next/image";
import type * as React from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** Centred single-column card (max 420 px) for all auth pages; no app shell (04-ui-ux §4.9). */
export function AuthCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="w-full max-w-[420px]">
      <CardHeader className="gap-3">
        <Image src="/icon.svg" alt="" width={40} height={40} className="size-10 rounded-lg" unoptimized />
        <CardTitle>
          <h1 className="font-semibold text-xl">{title}</h1>
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}
