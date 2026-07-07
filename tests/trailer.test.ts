import test from "node:test";
import assert from "node:assert/strict";
import { formatMoveId, parseTrailers, serializeTrailers } from "../packages/core/src/index.ts";

test("parseTrailers reads the final trailer block", () => {
  const trailers = parseTrailers(`move: example

Goal: human text is not a trailer block because of the blank line below.

Hunsu-Event: move
Hunsu-Run: run/example
Hunsu-Move: 7
Hunsu-Move: 0008
`);

  assert.deepEqual(trailers.get("Hunsu-Move"), ["7", "0008"]);
  assert.equal(trailers.get("Hunsu-Event")?.[0], "move");
});

test("serializeTrailers omits undefined values", () => {
  assert.equal(
    serializeTrailers({
      "Hunsu-Event": "move",
      "Hunsu-Priority": undefined
    }),
    "Hunsu-Event: move"
  );
});

test("formatMoveId normalizes numeric move selectors", () => {
  assert.equal(formatMoveId("7"), "M0007");
  assert.equal(formatMoveId("M12"), "M0012");
});
