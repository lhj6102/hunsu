# Local Development

Install dependencies and start the isolated stack:

~~~sh
pnpm install
pnpm dev:stack
~~~

The stack creates a temporary HUNSU_HOME, allocates random Bridge, Web, and
Relay ports, starts a deterministic local Relay fixture, starts the foreground
daemon with fake Codex, waits for health, starts Web, prefixes child output,
and cleans up processes and state on exit.

Safe startup output contains only local URLs and the temporary state path:

~~~text
[bridge] ready at http://127.0.0.1:43127
[web]    ready at http://hunsu.localhost:5173
[relay]  ready at http://127.0.0.1:43128
[state]  /tmp/hunsu-dev-abc123
[timing] daemon ready: 420 ms
[timing] Web ready: 910 ms
~~~

It never prints pairing or control credentials.

## Browser modes

Fast proxy mode is the default loop:

~~~text
browser -> hunsu.localhost Web dev server
        -> same-origin development proxy
        -> random-port Bridge daemon
~~~

Direct-localhost contract mode separately exercises browser-to-127.0.0.1
pairing, token consumption, address-bar cleanup, authentication, CORS, Private
Network Access behavior, streams, and Workspace Open.

Development never maps hunsu.app in the hosts file and never reuses production
cookies, storage, service workers, or OAuth state. If a .localhost subdomain is
unavailable, use a 127.0.0.1 origin.

## Deterministic tests

tests/fixtures/fake-codex.mjs and tests/fixtures/fake-relay.mjs provide
credential-free provider and Relay behavior. Automated tests create disposable
Git repositories and never use a developer's real Workspace registry.

Run the complete normal gate with:

~~~sh
pnpm verify:bridge
~~~

It runs the no-desktop and state-boundary guards, typecheck, headless unit and
contract tests, foreground CLI scenario, proxy/direct Chromium E2E, and the npm
tarball smoke. It prints elapsed time for the test suite, foreground scenario,
Web modes, package smoke, and full gate. The target is five minutes on Ubuntu
after dependencies and Chromium are installed. CI enforces that target only
after a documented 30-second scheduling threshold.

The foreground scenario can also run by itself without GitHub Actions or an OS
user service:

~~~sh
pnpm run test:headless:scenario
~~~

It starts one daemon and local Relay, exercises status, fake Codex setup/check,
Workspace add/list/inspect, pairing, Web proxy health, device login, Remote
enable and command round-trip, Workspace revocation, authenticated shutdown,
port release, and credential-leak checks.
