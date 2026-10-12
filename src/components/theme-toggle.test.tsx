import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { ThemeProvider } from "./theme-provider";
import { ThemeToggle } from "./theme-toggle";

test("SMOKE theme toggle switches between light and dark with a German label", async () => {
  render(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>,
  );
  const button = screen.getByRole("button", { name: "Dunkles Design aktivieren" });
  await userEvent.click(button);
  expect(document.documentElement).toHaveClass("dark");
  expect(screen.getByRole("button", { name: "Helles Design aktivieren" })).toBeInTheDocument();
});
