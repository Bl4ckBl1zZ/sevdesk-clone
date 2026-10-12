import { describe, expect, test } from "vitest";
import { amount, date102, el, escapeXml, leaf, percent, price, quantity, renderXml } from "./xml";

describe("XML writer", () => {
  test("EC-096 text is escaped and characters outside XML 1.0 are dropped; emoji and RTL survive", () => {
    expect(escapeXml("A & B <c> d")).toBe("A &amp; B &lt;c&gt; d");
    expect(escapeXml("Zeile 1\r\nZeile 2\tTab")).toBe("Zeile 1&#13;\nZeile 2\tTab");
    expect(escapeXml("Null\u0000Bell\u0007Esc\u001b￾")).toBe("NullBellEsc");
    expect(escapeXml("Café 😀 שלום")).toBe("Café 😀 שלום");
  });

  test("EC-DOC-80 attributes escape quotes; empty leaves and containers are omitted", () => {
    const root = el(
      "a",
      { x: 'say "hi"', skip: undefined },
      leaf("b", "1 < 2"),
      leaf("c", ""),
      leaf("d", undefined),
      el("e", null, leaf("f", null)),
      false,
    );
    expect(root).not.toBeNull();
    expect(renderXml(root as NonNullable<typeof root>)).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<a x="say &quot;hi&quot;">\n  <b>1 &lt; 2</b>\n</a>\n',
    );
    expect(el("empty", null, null)).toBeNull();
  });

  test("INV-19 number and date formats for EN 16931 syntaxes", () => {
    expect(amount(119_000)).toBe("1190.00");
    expect(amount(-12_000)).toBe("-120.00");
    expect(amount(5)).toBe("0.05");
    expect(quantity(10_000)).toBe("10");
    expect(quantity(1_500)).toBe("1.5");
    expect(quantity(-2_000)).toBe("-2");
    expect(price(1_000_000)).toBe("100.00");
    expect(price(100_050)).toBe("10.005");
    expect(price(168_000)).toBe("16.80");
    expect(percent(1900)).toBe("19.00");
    expect(percent(0)).toBe("0.00");
    expect(date102("2026-10-12")).toBe("20261012");
  });
});
