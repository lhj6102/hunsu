# Domain modeling rules

Hunsu domain models make valid and invalid lifecycle states visible in the type system.

## Required patterns

- Use branded primitives for identifiers, full Git SHAs, refs, timestamps, non-empty text, and positive or non-negative integers.
- Represent lifecycle variants with discriminated unions. Terminal Run variants contain only fields valid for that terminal outcome.
- Keep `Runner` as the closed union `Team | Player`; never use it for infrastructure.
- Capture immutable Goal and Runner snapshots when a Run starts.
- Return `Result<T, E>` from parsing, validation, command decisions, event application, configuration, and external boundaries where failure is expected.
- Decode untrusted JSON into `unknown`, validate every required field, reject unknown schema versions, and return a typed error.
- Use exhaustive switches. A new command, event, Run variant, decision, or resource kind must make every dependent switch fail compilation until updated.
- Keep domain commands separate from stored event envelopes and transport DTOs.

## Forbidden patterns

- optional fields that approximate a lifecycle union;
- casts that skip validation at an external boundary;
- compatibility aliases or permissive legacy decoders;
- filesystem paths, HTTP requests, GitHub SDK values, cookies, or Codex sessions in protocol or core;
- secrets, mutable local paths, or installation credentials in domain state;
- Coach output directly applying a user decision.

Every durable mutation must produce an event that can be replayed from an empty state. Snapshots and query models are always derived.
