import { render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, expect, test } from "vitest";
import { HydrationMarker } from "./hydration-marker";

afterEach(() => {
  delete document.documentElement.dataset.hydrated;
});

test("SMOKE <html data-hydrated> is set only once React has hydrated (E2E readiness signal)", () => {
  expect(renderToString(<HydrationMarker />)).toBe("");
  expect(document.documentElement).not.toHaveAttribute("data-hydrated");
  render(<HydrationMarker />);
  expect(document.documentElement).toHaveAttribute("data-hydrated", "true");
});
