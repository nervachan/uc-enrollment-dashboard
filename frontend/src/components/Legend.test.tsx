import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { Legend } from "./Legend";
import type { Scale } from "../lib/api";

const base: Scale = {
  level: "province",
  metric: "headcount",
  min: 1,
  max: 19871,
  breaks: [161, 395, 786, 1093],
  method: "quantile",
};

describe("Legend", () => {
  it("labels every class with its range", () => {
    render(<Legend scale={base} />);
    expect(screen.getByText("Students")).toBeInTheDocument();
    expect(screen.getByText(/1–160/)).toBeInTheDocument();
    expect(screen.getByText(/1.1K\+/)).toBeInTheDocument();
  });

  it("names the measure being coloured", () => {
    render(<Legend scale={{ ...base, metric: "records" }} />);
    expect(screen.getByText("Enrollment records")).toBeInTheDocument();
  });

  it("discloses a log scale rather than passing it off as linear", () => {
    render(<Legend scale={{ ...base, method: "logarithmic", breaks: [8, 66, 538, 4373] }} />);
    expect(screen.getByText("log scale")).toBeInTheDocument();
  });

  it("says nothing extra when the classes are quantiles", () => {
    render(<Legend scale={base} />);
    expect(screen.queryByText("log scale")).not.toBeInTheDocument();
  });
});
