# Privacy

Hunsu is designed so sensitive repository access happens in Hunsu Bridge on the
user's machine.

## What Runs Where

- Hunsu Web renders Studio and Hub views in the browser.
- Hunsu Bridge runs on localhost and owns repository access, Git worktrees,
  Codex runner integration, Agent Conversation references, and Artifact Action
  execution.
- Hunsu Hub stores public or user-published Team, Member, Manager, and Skill
  package metadata and immutable package manifests.

## Repository Data

Hunsu Bridge may read repository files, Git history, `.hunsu` runtime files, and
configured Artifact Action outputs for the Roadmap you open. This data is used
locally to render Studio, execute agents, and record Hunsu runtime commits.

Hunsu Web should not receive repository data unless your browser is connected to
your own Hunsu Bridge instance and the UI needs that data to render the selected
Roadmap.

## Bridge API Pairing

When you start Studio through the CLI, Hunsu Bridge creates a pairing token and
passes it to the browser. The browser stores the token in local storage for the
current Studio origin and sends it to protected Bridge APIs. You can clear it by
clearing site data for that Studio origin.

## Provider Data

Agent prompts, model outputs, and provider session identifiers may be sent to the
configured provider runtime, such as Codex, when you start an Execute or Hunsu
Draft. Provider transcripts remain provider/runtime data unless Hunsu explicitly
records compact references or evidence in local state.

## Hub Data

Published Hub packages are intended to be shared. Do not publish private prompts,
secrets, proprietary Skill files, or package manifests that include sensitive
metadata.
