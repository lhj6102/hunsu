# @hunsu/bridge

The headless Hunsu Bridge daemon and its authenticated CLI client.

```sh
npx @hunsu/bridge@next setup
npx @hunsu/bridge@next status
npx @hunsu/bridge@next open
```

The installed user service runs an exact package version from `HUNSU_HOME`, not
from the npm cache. Use `hunsu-bridge dev --port 0` for an isolated foreground
development daemon.
