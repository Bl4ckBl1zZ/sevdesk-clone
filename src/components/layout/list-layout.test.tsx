import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { ListLayout } from "./list-layout";

describe("ListLayout (04 §1, §2 phone cards)", () => {
  test("MISC-10 phone cards keep space for the floating „Neu“ button so the last card stays readable", () => {
    render(<ListLayout cards={<article>Letzte Karte</article>} />);
    const cards = screen.getByText("Letzte Karte").parentElement;
    expect(cards?.className).toMatch(/max-md:pb-16/);
    expect(cards?.className).toMatch(/@3xl\/main:hidden/);
  });
});
