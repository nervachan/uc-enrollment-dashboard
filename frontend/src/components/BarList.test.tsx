import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { BarList } from "./BarList";

const data = [
  { key: "CONAHS", value: 7001 },
  { key: "CITCS", value: 5200 },
  { key: "COE", value: 300 },
];

describe("BarList", () => {
  it("renders every value as a number, not only as a bar", () => {
    render(<BarList title="Colleges" data={data} />);
    expect(screen.getByText("7,001")).toBeInTheDocument();
    expect(screen.getByText("5,200")).toBeInTheDocument();
  });

  it("scales bar width against the largest value in view", () => {
    render(<BarList title="Colleges" data={data} />);
    expect(screen.getByTestId("bar-CONAHS").style.width).toBe("100%");
    expect(parseFloat(screen.getByTestId("bar-COE").style.width)).toBeCloseTo((300 / 7001) * 100, 4);
  });

  it("never renders a zero-width bar for a non-zero value", () => {
    render(<BarList title="Colleges" data={[{ key: "A", value: 10000 }, { key: "B", value: 1 }]} />);
    expect(parseFloat(screen.getByTestId("bar-B").style.width)).toBeGreaterThan(1);
  });

  it("shows shares when a total is supplied", () => {
    render(<BarList title="Colleges" data={data} total={12501} />);
    expect(screen.getByText("56%")).toBeInTheDocument();
  });

  it("respects the limit", () => {
    render(<BarList title="Colleges" data={data} limit={2} />);
    expect(screen.queryByText("COE")).not.toBeInTheDocument();
  });

  it("titles programme names instead of shouting them", () => {
    render(<BarList title="Programs" data={[{ key: "BACHELOR OF SCIENCE IN NURSING", value: 5 }]} humanise />);
    expect(screen.getByText("Bachelor of Science in Nursing")).toBeInTheDocument();
  });

  it("acts as a filter control when a handler is given", async () => {
    const onSelect = vi.fn();
    render(<BarList title="Colleges" data={data} onSelect={onSelect} selected={["CITCS"]} />);
    await userEvent.click(screen.getByText("COE"));
    expect(onSelect).toHaveBeenCalledWith("COE");
    expect(screen.getByRole("button", { name: /CITCS/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("says so when there is nothing to show", () => {
    render(<BarList title="Colleges" data={[]} />);
    expect(screen.getByText(/No data for these filters/)).toBeInTheDocument();
  });
});
