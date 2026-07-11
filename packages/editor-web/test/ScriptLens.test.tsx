// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { EditorSession } from "@ludelier/editor-core";
import type { Story } from "@ludelier/schema";
import { ScriptLens } from "../src/storymap/ScriptLens";

const base: Story = {
  meta: { id: "t", title: "T", start: "a" },
  characters: [{ id: "n", name: "N" }],
  assets: [],
  nodes: [{ id: "a", body: [{ op: "say", who: "n", text: "hi" }, { op: "end" }] }],
};

function sessionAndNode() {
  const session = new EditorSession(base);
  // The log normalizes statement ids on load ("a#0", "a#1"), so the lens shows stable ids.
  const node = session.story.nodes.find((n) => n.id === "a");
  if (!node) throw new Error("node a missing");
  return { session, node };
}

afterEach(cleanup);

describe("ScriptLens", () => {
  it("prompts to pick a node when none is selected", () => {
    const session = new EditorSession(base);
    render(<ScriptLens node={null} session={session} manifest={session.describe()} />);
    expect(screen.getByText(/select a node/i)).toBeTruthy();
  });

  it("renders each statement with its stable id and per-statement controls", () => {
    const { session, node } = sessionAndNode();
    const { container } = render(<ScriptLens node={node} session={session} manifest={session.describe()} />);
    const lens = screen.getByTestId("script-lens");
    expect(container.querySelectorAll("li.stmt")).toHaveLength(2);
    const ids = [...container.querySelectorAll(".stmt-id")].map((el) => el.textContent);
    expect(ids).toEqual(["#a#0", "#a#1"]);
    // Parity payoff: every statement gets edit + remove entry points (the agent's ops).
    expect(within(lens).getAllByRole("button", { name: "edit" })).toHaveLength(2);
    expect(within(lens).getAllByRole("button", { name: "×" })).toHaveLength(2);
  });

  it("removes a statement through session.edit() when × is clicked", () => {
    const { session, node } = sessionAndNode();
    render(<ScriptLens node={node} session={session} manifest={session.describe()} />);
    const removeButtons = within(screen.getByTestId("script-lens")).getAllByRole("button", {
      name: "×",
    });
    fireEvent.click(removeButtons[0]);
    // The say ("a#0") is gone; the node keeps only its terminal end.
    const after = session.story.nodes.find((n) => n.id === "a");
    expect(after?.body).toHaveLength(1);
    expect(after?.body[0]?.op).toBe("end");
  });

  it("toggles the add-statement form open", () => {
    const { session, node } = sessionAndNode();
    render(<ScriptLens node={node} session={session} manifest={session.describe()} />);
    fireEvent.click(screen.getByRole("button", { name: /Add statement/ }));
    // The add form (a manifest-derived TaskForm) mounts with its own submit button.
    expect(screen.getByRole("button", { name: "Add statement" })).toBeTruthy();
  });
});
