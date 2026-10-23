import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { LayoutForm } from "./layout-form";

describe("LayoutForm", () => {
  test("SET-077 shows a contrast warning for an accent colour below 3:1 on white, none for the default", async () => {
    renderWithIntl(
      <LayoutForm id="f" defaultValues={{ template: "classic", accentColor: "#1F6FEB" }} onValid={() => {}} />,
    );
    expect(screen.queryByTestId("accent-contrast-warning")).toBeNull();
    fireEvent.input(screen.getByLabelText("Akzentfarbe"), { target: { value: "#ffe066" } });
    const warning = await screen.findByTestId("accent-contrast-warning");
    expect(warning).toHaveAttribute("role", "status");
    expect(warning).toHaveTextContent("nur einen Kontrast von 1,3:1 (empfohlen mindestens 3:1)");
  });
});
