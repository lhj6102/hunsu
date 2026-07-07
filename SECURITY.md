# Security Policy

Hunsu is local-first. Hunsu Web is a browser UI, while Hunsu Local is the
localhost runtime that can read repositories, create Git worktrees, run Codex,
and execute Artifact Actions.

## Supported Versions

Public alpha work is tracked on the main repository. Until the first stable
release, security fixes target the latest `main` branch and the latest published
`0.x` npm packages.

## Reporting A Vulnerability

Please report security issues privately before opening a public issue. If no
dedicated disclosure address is listed in the repository hosting profile, open a
minimal issue asking for a private security contact without including exploit
details.

Include:

- affected version or commit
- operating system and Node version
- exact Hunsu command or API route involved
- whether Hunsu Local was bound to `127.0.0.1` or another host
- whether a pairing token or Artifact Action command was involved

## Local API Boundary

Hunsu Local defaults to localhost and should stay bound to `127.0.0.1` for
normal use. Browser access to protected Local APIs requires:

- an allowed `Origin`
- a short-lived pairing token supplied by the Local launcher
- no cookies or ambient browser credentials

Do not expose Hunsu Local directly to a public network. If you intentionally bind
to `0.0.0.0`, put it behind your own authenticated transport and understand that
Local can operate on repositories and execute configured commands.

## Artifact Actions

Artifact Actions are explicit local runtime actions. They can run shell commands
declared in committed Hunsu runtime state. Treat Artifact Action definitions from
untrusted repositories like you would treat package scripts, CI jobs, or
Makefiles from an untrusted repository: review them before running.

## Secrets

Do not commit real tokens, `.env` files, provider credentials, private keys, or
agent transcripts containing secrets. Example env files must contain placeholders
only.
