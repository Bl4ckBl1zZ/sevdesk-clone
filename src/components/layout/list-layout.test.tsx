import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { ListLayout, StatusFilter } from "./list-layout";

describe("ListLayout (04 §1, §2 phone cards)", () => {
  test("MISC-10 phone cards keep space for the floating „Neu“ button so the last card stays readable", () => {
    render(<ListLayout cards={<article>Letzte Karte</article>} />);
    const cards = screen.getByText("Letzte Karte").parentElement;
    expect(cards?.className).toMatch(/max-md:pb-16/);
    expect(cards?.className).toMatch(/@3xl\/main:hidden/);
  });

  test("MOT-006 phone cards give press feedback; status tabs fade between states", () => {
    render(
      <>
        <ListLayout cards={<article>Karte</article>} />
        <StatusFilter
          label="Status"
          current="all"
          options={[
            { value: "all", label: "Alle", href: "/rechnungen" },
            { value: "open", label: "Offen", href: "/rechnungen?status=open" },
          ]}
        />
      </>,
    );
    const cards = screen.getByText("Karte").parentElement;
    expect(cards?.className).toMatch(/\*:active:scale-\[0\.99\]/);
    expect(screen.getByRole("link", { name: "Offen" }).className).toMatch(/transition-\[/);
  });
});
