import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { StatTiles } from "./StatTiles";
import { TrendChart } from "./TrendChart";

const totals = {
  headcount: 38007,
  records: 158098,
  programs: 80,
  municipalities: 752,
  provinces: 75,
  countries: 32,
};

describe("StatTiles", () => {
  it("shows students and enrollment records as separate figures", () => {
    render(<StatTiles totals={totals} metric="headcount" />);
    expect(screen.getByText("38,007")).toBeInTheDocument();
    expect(screen.getByText("158,098")).toBeInTheDocument();
    expect(screen.getByText("distinct people")).toBeInTheDocument();
  });
});

describe("TrendChart", () => {
  const trend = [
    { year: 2023, headcount: 20312, records: 46343 },
    { year: 2024, headcount: 19860, records: 46990 },
    { year: 2025, headcount: 19807, records: 47063 },
  ];

  it("plots one point per school year", () => {
    render(<TrendChart data={trend} metric="headcount" />);
    expect(screen.getByText("2023")).toBeInTheDocument();
    expect(screen.getByText("2025")).toBeInTheDocument();
  });

  it("reads out the hovered year, and the readout follows the measure", () => {
    const { rerender } = render(<TrendChart data={trend} metric="headcount" />);
    fireEvent.mouseEnter(screen.getByTestId("hit-2024"));
    expect(screen.getByTestId("trend-readout")).toHaveTextContent("SY 2024: 19,860");
    rerender(<TrendChart data={trend} metric="records" />);
    fireEvent.mouseEnter(screen.getByTestId("hit-2024"));
    expect(screen.getByTestId("trend-readout")).toHaveTextContent("SY 2024: 46,990");
  });

  it("handles an empty result", () => {
    render(<TrendChart data={[]} metric="headcount" />);
    expect(screen.getByText(/No data for these filters/)).toBeInTheDocument();
  });

  it("does not divide by zero with a single point", () => {
    render(<TrendChart data={[trend[0]]} metric="headcount" />);
    expect(screen.getByText("2023")).toBeInTheDocument();
  });
});
