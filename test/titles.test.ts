import { describe, expect, it } from "vitest";
import { cleanTitle } from "../server/runs.js";

describe("chat titles", () => {
  it("keeps a short clean name", () => {
    expect(cleanTitle('"Habit tracker app."')).toBe("Habit tracker app");
    expect(cleanTitle("Title: Snake game with scores\n\nextra")).toBe("Snake game with scores");
    expect(cleanTitle("<think>hmm</think>\nאפליקציית מתכונים")).toBe("אפליקציית מתכונים");
    expect(cleanTitle("**Landing page**")).toBe("Landing page");
  });
  it("drops answers that aren't a name", () => {
    expect(cleanTitle("")).toBe("");
    expect(cleanTitle("This is a very long sentence that the model wrote instead of a short name for the chat")).toBe("");
  });
});
