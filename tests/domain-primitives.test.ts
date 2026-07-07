import test from "node:test";
import assert from "node:assert/strict";
import {
  makeDestinationAcceptanceCriterion,
  makeDestinationConstraint,
  makeDestinationNotes,
  makeMoveCommit,
  makeRiskText,
  makeRouteId
} from "../packages/protocol/src/index.ts";

test("RouteId constructor rejects empty and whitespace values", () => {
  assert.equal(makeRouteId("").ok, false);
  assert.equal(makeRouteId("route 001").ok, false);
});

test("RouteId constructor brands non-empty route identifiers", () => {
  const routeId = makeRouteId("route_001");

  assert.equal(routeId.ok, true);
  if (routeId.ok) {
    assert.equal(routeId.value, "route_001");
  }
});

test("RiskText constructor rejects empty risk descriptions", () => {
  assert.equal(makeRiskText("").ok, false);
  assert.equal(makeRiskText("   ").ok, false);
});

test("MoveCommit constructor rejects empty commit references", () => {
  assert.equal(makeMoveCommit("").ok, false);
  assert.equal(makeMoveCommit("abc123").ok, true);
});

test("Destination text constructors reject empty detail text", () => {
  assert.equal(makeDestinationAcceptanceCriterion("").ok, false);
  assert.equal(makeDestinationConstraint("   ").ok, false);
  assert.equal(makeDestinationNotes("").ok, false);
});
