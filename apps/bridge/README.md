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

The installed user service runs an exact package version from `HUNSU_HOME`, not
from the npm cache. Use `hunsu-bridge dev --port 0` for an isolated foreground
development daemon.

For advanced local package verification only, run setup from an absolute
tarball path:

```sh
hunsu-bridge setup --runtime-package /absolute/path/hunsu-bridge-0.2.0-next.1.tgz
```

This option rejects URLs, dist-tags, ranges, Git specs, relative paths, and
packages other than the exact `@hunsu/bridge` candidate.
