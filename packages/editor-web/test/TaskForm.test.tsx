// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EditorSession } from "@ludelier/editor-core";
import type { Story } from "@ludelier/schema";
import { TaskForm } from "../src/forms/TaskForm";

const base: Story = {
  meta: { id: "t", title: "T", start: "a" },
  characters: [{ id: "n", name: "N" }],
  assets: [],
  nodes: [{ id: "a", body: [{ op: "say", who: "n", text: "hi" }, { op: "end" }] }],
};

/** The manifest schema for a task — the exact JSON Schema the form derives its fields from. */
function schemaOf(session: EditorSession, name: string): unknown {
  const entry = session.describe().find((t) => t.name === name);
  if (!entry) throw new Error(`no task "${name}" in manifest`);
  return entry.schema;
}

afterEach(cleanup);

describe("TaskForm — manifest-driven human edit form (parity)", () => {
  it("applies a create-node edit through session.edit() on submit", () => {
    const session = new EditorSession(base);
    let doneCount = 0;
    render(
      <TaskForm
        session={session}
        name="create-node"
        schema={schemaOf(session, "create-node")}
        onDone={() => {
          doneCount += 1;
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText("id"), { target: { value: "newroom" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    // The form routes through the same chokepoint the agent uses, so the session story updates.
    expect(session.story.nodes.some((n) => n.id === "newroom")).toBe(true);
    expect(doneCount).toBe(1);
  });

  it("surfaces the world's semantic issues inline and leaves the story untouched on failure", () => {
    const session = new EditorSession(base);
    const { container } = render(
      <TaskForm session={session} name="create-node" schema={schemaOf(session, "create-node")} />,
    );
    // "a" already exists → the world task rejects it; the form must show the issue, not throw.
    fireEvent.change(screen.getByLabelText("id"), { target: { value: "a" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(container.querySelector(".form-issues")?.textContent).toMatch(/already exists/);
    expect(session.story.nodes).toHaveLength(1);
  });

  it("uses a custom submit label when given", () => {
    const session = new EditorSession(base);
    render(
      <TaskForm
        session={session}
        name="create-node"
        schema={schemaOf(session, "create-node")}
        submitLabel="Create node"
      />,
    );
    expect(screen.getByRole("button", { name: "Create node" })).toBeTruthy();
  });
});
