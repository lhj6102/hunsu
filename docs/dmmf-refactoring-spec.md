# Domain modeling rules

Hunsu domain models make valid and invalid lifecycle states visible in the type system.

## Required patterns

- Use branded primitives for identifiers, full Git SHAs, refs, timestamps, digests, non-empty text, and positive or non-negative integers.
- Represent root, Run-child, and Coaching-child Nodes as explicit discriminated variants.
- Represent terminal Run variants with only the fields valid for that outcome.
- Model Runner as an immutable value object with an exact type lock, canonical payload, and integrity digest. Player and Team are bundled registered types, not an exhaustive domain union.
- Capture exactly one immutable Goal value and the source Node's Runner value when a Run starts.
- Represent `sibling_runs` and `coached_how_experiment` comparisons as an exact discriminated union. Require the comparison discriminant at every command and decoding boundary.
- Bind a coached-How comparison to its anchor, canonical Goal digest, completed result Nodes, and exact cohort key. Validate direct confirmed Coaching sources, same-tree preservation, and source plans that differ only in How.
- Store a Coaching proposal's required evidence summary and rationale as separate values; never collapse either value into a generic reason.
- Return `Result<T, E>` from parsing, validation, command decisions, event application, configuration, registry resolution, and external boundaries where failure is expected.
- Decode untrusted JSON into `unknown`, validate every required field, reject extra fields and unknown schema versions, and return a typed error.
- Resolve a Runner type lock through the exact registry decoder before any executor sees its payload. Unknown type locks fail closed.
- Use exhaustive switches. A new command, event, Node, Run, decision, or resource variant must make every dependent switch fail compilation until updated.
- Keep domain commands separate from stored event envelopes and transport DTOs.

## Forbidden patterns

- optional fields that approximate a lifecycle union;
- casts that skip validation at an external boundary;
- compatibility aliases, v1 fallbacks, or permissive legacy decoders;
- a mutable Project-level Goal or Runner directory;
- treating Player and Team as the only possible Runner types;
- filesystem paths, HTTP requests, GitHub SDK values, cookies, or Codex sessions in protocol or core;
- secrets, mutable local paths, or installation credentials in domain state;
- Coach output directly applying a transition or user decision;
- structural edges with missing targets or Nodes with multiple structural parents.
- optional anchor/parent fields that approximate comparison variants, implicit comparison-type inference, or comparison aliases;
- treating a comparison or decision as a structural edge, merge, or convergence operation.

Every durable mutation must produce an event that can be replayed from an empty v2 state. Node payload materializations, Graph snapshots, Events views, and query models are always derived.
