"use client";

import { LogOutIcon, SettingsIcon, UserRoundIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { useSessionState } from "@/components/auth/session-provider";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { authClient } from "@/lib/auth-client";

export function AccountMenu() {
  const t = useTranslations("shell");
  const tNav = useTranslations("nav.items");
  const router = useRouter();
  const { markSigningOut } = useSessionState();
  const { data } = authClient.useSession();
  const email = data?.user.email;

  const signOut = async () => {
    markSigningOut();
    try {
      await authClient.signOut();
      router.replace("/anmelden");
      router.refresh();
    } catch {
      toast.error(t("signOutFailed"));
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={t("accountMenu")} />}>
        <UserRoundIcon aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col gap-0.5">
            <span className="text-muted-foreground text-xs">{email ? t("signedInAs") : t("notSignedIn")}</span>
            {email && <span className="truncate font-medium text-foreground">{email}</span>}
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => router.push("/konto")}>
          <UserRoundIcon aria-hidden="true" />
          {tNav("konto")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => router.push("/einstellungen")}>
          <SettingsIcon aria-hidden="true" />
          {tNav("einstellungen")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void signOut()}>
          <LogOutIcon aria-hidden="true" />
          {t("signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
