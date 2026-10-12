import { ThemeToggle } from "@/components/theme-toggle";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function Home() {
  return (
    <main className="@container/main mx-auto flex min-h-dvh max-w-3xl flex-col gap-6 p-4 @lg/main:p-8">
      <header className="flex items-center justify-between gap-4">
        <h1 className="font-semibold text-2xl tracking-tight">Rechnungen</h1>
        <ThemeToggle />
      </header>
      <Card>
        <CardHeader>
          <CardTitle>Grundgerüst</CardTitle>
          <CardDescription>Phase P0 — die Anwendung wird gerade aufgebaut.</CardDescription>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">
          Spezifikation: <code>docs/spec/README.md</code>
        </CardContent>
      </Card>
    </main>
  );
}
