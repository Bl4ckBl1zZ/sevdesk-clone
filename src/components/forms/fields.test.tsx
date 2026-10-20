import { render, screen } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { describe, expect, test } from "vitest";
import { SelectField } from "./fields";

function Harness({ options }: { options: { value: string; label: string }[] }) {
  const form = useForm<{ projectId: string }>({ defaultValues: { projectId: "p1" } });
  return <SelectField form={form} name="projectId" label="Projekt" placeholder="Kein Projekt" options={options} />;
}

describe("SelectField", () => {
  test("PRJ-007 a preselected value is shown once its options load after the form (async option queries)", () => {
    const { rerender } = render(<Harness options={[]} />);
    rerender(<Harness options={[{ value: "p1", label: "Website-Relaunch (PRJ-00001)" }]} />);
    expect(screen.getByLabelText("Projekt")).toHaveValue("p1");
  });
});
