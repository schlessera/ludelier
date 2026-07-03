import { describe, expect, it } from "vitest";
import { validateStory, type Story } from "@ludelier/schema";
import { initialState, reducer } from "../src/reducer";
import { Simulation } from "../src/simulation";

/** A small story exercising scene/show/hide across blocking statements. */
function build(bg = "bg_room"): Story {
  const res = validateStory({
    meta: { id: "s", title: "Stage", start: "a", seed: 1 },
    characters: [{ id: "n", name: "Narrator" }],
    assets: [
      { id: "bg_room", src: "/bg/room.png" },
      { id: "bg_hall", src: "/bg/hall.png" },
      { id: "her", src: "/char/her.png" },
      { id: "him", src: "/char/him.png" },
    ],
    nodes: [
      {
        id: "a",
        body: [
          { op: "scene", bg },
          { op: "show", sprite: "her", asset: "her", at: "left" },
          { op: "say", who: "n", text: "one" },
          { op: "show", sprite: "him", asset: "him", at: "right" },
          { op: "show", sprite: "her", asset: "her", at: "center" }, // replaces the slot
          { op: "say", who: "n", text: "two" },
          { op: "hide", sprite: "her" },
          { op: "scene", bg: "bg_hall" }, // clears all sprites
          { op: "say", who: "n", text: "three" },
          { op: "end" },
        ],
      },
    ],
  });
  if (!res.success) throw new Error("fixture invalid: " + JSON.stringify(res.issues));
  return res.data;
}

describe("stage (scene/show/hide)", () => {
  it("resolves scene + show before the first blocking say", () => {
    const story = build();
    const s = initialState(story, 1);
    expect(s.pending.kind).toBe("say");
    expect(s.stage.bg).toBe("bg_room");
    expect(s.stage.sprites).toEqual([{ id: "her", asset: "her", at: "left" }]);
  });

  it("keeps sprites sorted by id and replaces a reused slot", () => {
    const story = build();
    let s = initialState(story, 1);
    s = reducer(story, s, { type: "ADVANCE" }); // show him, replace her -> say "two"
    // Sorted by id: "her" before "him"; "her" now centered (replaced), not left.
    expect(s.stage.sprites).toEqual([
      { id: "her", asset: "her", at: "center" },
      { id: "him", asset: "him", at: "right" },
    ]);
  });

  it("hide removes a slot and a new scene clears all sprites", () => {
    const story = build();
    let s = initialState(story, 1);
    s = reducer(story, s, { type: "ADVANCE" }); // -> "two"
    s = reducer(story, s, { type: "ADVANCE" }); // hide her, scene bg_hall -> "three"
    expect(s.stage.bg).toBe("bg_hall");
    expect(s.stage.sprites).toEqual([]);
  });

  it("the stage is part of the deterministic hash", () => {
    // Two runs identical except the background asset must hash differently.
    const a = new Simulation(build("bg_room"), { seed: 1 });
    const b = new Simulation(build("bg_hall"), { seed: 1 });
    expect(a.hash()).not.toBe(b.hash());
  });

  it("hiding an absent slot is a no-op", () => {
    const res = validateStory({
      meta: { id: "h", title: "h", start: "a", seed: 1 },
      characters: [{ id: "n", name: "Narrator" }],
      nodes: [
        {
          id: "a",
          body: [
            { op: "hide", sprite: "ghost" },
            { op: "say", who: "n", text: "ok" },
          ],
        },
      ],
    });
    if (!res.success) throw new Error("invalid: " + JSON.stringify(res.issues));
    const s = initialState(res.data, 1);
    expect(s.pending.kind).toBe("say");
    expect(s.stage.sprites).toEqual([]);
  });
});
