// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ExploreReport, GraphReport } from "@ludelier/world";
import { HealthPanel } from "../src/health/HealthPanel";

afterEach(cleanup);

const graph: GraphReport = {
  entry: "a",
  nodes: ["a", "b", "c"],
  edges: [],
  reachable: ["a", "b", "c"],
  unreachable: [],
  deadEnds: [],
};

const clean: ExploreReport = {
  reached: ["a", "b", "c"],
  endReachable: true,
  stuck: [],
  truncated: false,
  crashed: false,
};

describe("HealthPanel", () => {
  it("renders a clean bill of health from both analyses", () => {
    render(<HealthPanel valid graph={graph} explore={clean} />);
    expect(screen.getByTestId("reached").textContent).toBe("3");
    expect(screen.getByTestId("not-reached").textContent).toBe("none");
    expect(screen.getByTestId("end-reachable").textContent).toBe("true");
    expect(screen.getByTestId("stuck").textContent).toBe("none");
    // The crashed / truncated notices only appear when their flag is set.
    expect(screen.queryByTestId("crashed")).toBeNull();
    expect(screen.queryByTestId("truncated")).toBeNull();
  });

  it("surfaces the static-vs-runtime divergence (wired but never played) as a warning", () => {
    // 'c' is statically reachable but no runtime path plays through it — the whole point of
    // surfacing explore beside graph. It is warning-grade, not blocking (mirrors the gate).
    render(<HealthPanel valid graph={graph} explore={{ ...clean, reached: ["a", "b"] }} />);
    const notReached = screen.getByTestId("not-reached");
    expect(notReached.textContent).toBe("c");
    expect(notReached.className).toContain("warn");
    expect(notReached.className).not.toContain("bad");
  });

  it("flags a blocking runtime failure: no ending reachable + a stuck node", () => {
    render(<HealthPanel valid graph={graph} explore={{ ...clean, endReachable: false, stuck: ["b"] }} />);
    expect(screen.getByTestId("end-reachable").textContent).toBe("false");
    expect(screen.getByTestId("end-reachable").className).toContain("bad");
    expect(screen.getByTestId("stuck").textContent).toBe("b");
    expect(screen.getByTestId("stuck").className).toContain("bad");
  });

  it("shows the crashed and truncated notices only when their flags are set", () => {
    render(<HealthPanel valid graph={graph} explore={{ ...clean, crashed: true, truncated: true }} />);
    expect(screen.getByTestId("crashed")).not.toBeNull();
    expect(screen.getByTestId("truncated")).not.toBeNull();
  });

  it("marks an invalid story as bad", () => {
    render(<HealthPanel valid={false} graph={graph} explore={clean} />);
    const valid = screen.getByText("false");
    expect(valid.className).toContain("bad");
  });
});
