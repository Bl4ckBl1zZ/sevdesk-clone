import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useRouteEnterAnimation } from "./route-transition";

const nav = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

let reduced = false;
const animate = vi.fn();

beforeEach(() => {
  nav.pathname = "/";
  reduced = false;
  animate.mockReset();
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes("reduce") ? reduced : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  HTMLElement.prototype.animate = animate as unknown as HTMLElement["animate"];
});
afterEach(() => vi.restoreAllMocks());

function Main() {
  const ref = useRef<HTMLElement>(null);
  useRouteEnterAnimation(ref);
  return <main ref={ref}>Inhalt</main>;
}

describe("motion (04-ui-ux §7.1)", () => {
  test("MOT-001 a page change fades the main area in; the first load does not animate", () => {
    const { rerender } = render(<Main />);
    expect(animate).not.toHaveBeenCalled();
    nav.pathname = "/rechnungen";
    rerender(<Main />);
    expect(animate).toHaveBeenCalledTimes(1);
    const [frames, options] = animate.mock.calls[0] as [Keyframe[], KeyframeAnimationOptions];
    expect(frames[0]).toMatchObject({ opacity: 0 });
    expect(frames.at(-1)).toMatchObject({ opacity: 1 });
    expect(options.duration).toBeLessThanOrEqual(250);
  });

  test("MOT-007 with reduced motion a page change does not animate", () => {
    reduced = true;
    const { rerender } = render(<Main />);
    nav.pathname = "/kontakte";
    rerender(<Main />);
    expect(animate).not.toHaveBeenCalled();
  });

  test("MOT-007 the global stylesheet defines the motion utilities and switches every animation off for reduced motion", () => {
    const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
    for (const name of ["rise", "grow-y", "grow-x"]) expect(css).toContain(`@keyframes ${name}`);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation-duration: 0\.01ms !important/);
  });
});
