import { isAnnotationId, leadingIds } from "./ids";

export interface TestRef {
  id: string;
  file: string;
  title: string;
  todo: boolean;
}

// test("…"), it("…"), describe("…"), test.todo("…"), test.skipIf(x)("…"), test.each(...)("…"), Playwright test.describe
const TITLE_RE =
  /\b(?:test|it|describe)(?:\.(?:only|skip|todo|concurrent|fails|sequential|describe|fixme|serial|each\([^)]*\)|skipIf\([^)]*\)|runIf\([^)]*\)))*\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g;

export function scanTests(file: string, source: string): TestRef[] {
  const refs: TestRef[] = [];
  for (const m of source.matchAll(TITLE_RE)) {
    const title = m[2] ?? "";
    const todo = /\.(?:todo|fixme)\b/.test(m[0]);
    for (const id of leadingIds(title)) if (!isAnnotationId(id)) refs.push({ id, file, title, todo });
  }
  return refs;
}
