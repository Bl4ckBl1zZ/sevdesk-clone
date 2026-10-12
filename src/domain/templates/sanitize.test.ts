import { describe, expect, test } from "vitest";
import { MAX_TEMPLATE_LENGTH, sanitizeTemplateHtml, validateTemplateBody } from "./sanitize";

describe("SET-081 template bodies are sanitised rich text", () => {
  test("SET-081 T-SET-046 <script> and onclick are stripped on save", () => {
    expect(sanitizeTemplateHtml('<p onclick="alert(1)">Hallo <script>alert("x")</script>Welt</p>')).toBe(
      "<p>Hallo Welt</p>",
    );
    expect(sanitizeTemplateHtml("<style>p{}</style><p>a</p><!-- x --><iframe src=x></iframe>")).toBe("<p>a</p>");
  });

  test("SET-081 the allowlist keeps p, br, strong, em, u, ul, ol, li, a and simple tables", () => {
    const html =
      "<p>Text<br><strong>fett</strong> <em>kursiv</em> <u>unter</u></p><ul><li>a</li></ul><ol><li>b</li></ol>" +
      "<table><tr><td>x</td></tr></table>";
    expect(sanitizeTemplateHtml(html)).toBe(html);
    // Unknown tags are removed but their text stays; attributes other than a[href] disappear.
    expect(sanitizeTemplateHtml('<div class="x"><span style="color:red">rot</span></div><b>b</b>')).toBe("rotb");
    expect(sanitizeTemplateHtml('<td colspan="2" style="x">z</td>')).toBe("<td>z</td>");
  });

  test("SET-081 links keep only http, https and mailto targets", () => {
    expect(sanitizeTemplateHtml('<a href="https://muster.de" target="_blank" onclick="x">Web</a>')).toBe(
      '<a href="https://muster.de">Web</a>',
    );
    expect(sanitizeTemplateHtml('<a href="mailto:info@muster.de">Mail</a>')).toBe(
      '<a href="mailto:info@muster.de">Mail</a>',
    );
    expect(sanitizeTemplateHtml('<a href="javascript:alert(1)">x</a>')).toBe("<a>x</a>");
    expect(sanitizeTemplateHtml('<a href=" JaVaScRiPt:alert(1)">x</a>')).toBe("<a>x</a>");
    expect(sanitizeTemplateHtml('<a href="data:text/html,x">x</a>')).toBe("<a>x</a>");
    expect(sanitizeTemplateHtml('<a href="https://x.de/?a=1&quot;onmouseover=1">x</a>')).toBe(
      '<a href="https://x.de/?a=1&quot;onmouseover=1">x</a>',
    );
  });

  test("SET-081 stray angle brackets are escaped, placeholders survive", () => {
    expect(sanitizeTemplateHtml("<p>1 < 2 und {{contact.name}} > 0</p>")).toBe(
      "<p>1 &lt; 2 und {{contact.name}} &gt; 0</p>",
    );
    expect(sanitizeTemplateHtml("<p>a <img src=x onerror=alert(1)> b</p>")).toBe("<p>a  b</p>");
  });

  test("SET-081 at most 20,000 characters", () => {
    expect(MAX_TEMPLATE_LENGTH).toBe(20_000);
    expect(validateTemplateBody("a".repeat(20_000)).ok).toBe(true);
    const r = validateTemplateBody("a".repeat(20_001));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ code: "TEMPLATE_TOO_LONG", message: "Höchstens 20.000 Zeichen." });
  });
});
