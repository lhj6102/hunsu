# Local Development

Install dependencies and start the isolated stack:

~~~sh
pnpm install
pnpm dev:stack
~~~

The stack creates a temporary HUNSU_HOME, allocates random Bridge and Web ports,
starts the foreground daemon, waits for health, starts Web, prefixes child
output, and cleans up processes and state on exit.

Safe startup output contains only local URLs and the temporary state path:

~~~text
[bridge] ready at http://127.0.0.1:43127
[web]    ready at http://hunsu.localhost:5173
[state]  /tmp/hunsu-dev-abc123
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

Run the normal gate with:

~~~sh
pnpm run check
pnpm run test:e2e:stack
pnpm run test:package:bridge
~~~
