# @hunsu/bridge

The headless Hunsu Bridge daemon and its authenticated CLI client.

> The headless prerelease is experimental. An exact candidate is published
> under `candidate-next` and reaches `next` only after registry, service, and
> production verification.

```sh
npx @hunsu/bridge@next setup
npx @hunsu/bridge@next status
npx @hunsu/bridge@next open
```

Preview QA uses the same canonical package with an explicit durable profile:

```sh
npx @hunsu/bridge@candidate-next setup --profile preview
```

`production` is the default profile. A populated `HUNSU_HOME` cannot switch
profiles; use a clean QA OS user or home for preview. The installed service
persists the selected profile and ignores ambient Web and Connect endpoint
overrides.

The installed user service runs an exact package version from `HUNSU_HOME`, not
from the npm cache. Use `hunsu-bridge dev --port 0` for an isolated foreground
development daemon. Development mode may use explicit endpoint overrides;
installed daemons use only the profile endpoint allowlist.

For advanced local package verification only, run setup from an absolute
tarball path:

```sh
hunsu-bridge setup --runtime-package /absolute/path/hunsu-bridge-0.2.0-next.10.tgz
```

This option rejects URLs, dist-tags, ranges, Git specs, relative paths, and
packages other than the exact `@hunsu/bridge` candidate.
