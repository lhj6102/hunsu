# Model Aliases

Model aliases are user-facing names for concrete provider model selections. Web
can send either an alias selection or a direct provider model selection before
Execute starts. Bridge validates both against the selected backend provider
inventory and resolves alias selections to a direct Codex selection for the
runner.

## Defaults

- `PrimaryModel`: Codex `gpt-5.5-thinking`, `high`, `default`
- `FastModel`: Codex `gpt-5.5`, `medium`, `fast`
- `ReviewerModel`: Codex `gpt-5.5-thinking`, `xhigh`, `default`
- `CheapModel`: Codex `gpt-5.5`, `low`, `default`

Alias scope is explicit:

```ts
{ kind: "user" }
{ kind: "workspace"; workspaceId: string }
{ kind: "team"; teamId: string }
{ kind: "local" }
```

Headless Bridge aliases use `{ kind: "local" }`. Web-authored aliases use user,
workspace, or team scope.

## Browser storage scope

Model aliases configured in Web are currently saved only in this browser with
`window.localStorage`. Their domain scope describes how Web applies an alias;
it does not mean the alias is synchronized through a Hunsu account, Workspace,
or Team. Account-, Workspace-, and Team-synchronized alias storage is a future
follow-up.

## Web config assignment

`/studio/settings/model-aliases` owns two Web-side settings:

- alias definitions in `hunsu.modelAliases.v1`
- a local Manager/Member/Executor config draft in `hunsu.modelConfigDraft.v1`

The config draft is the current Web-owned assignment path until a backend
mutation API exists. It stores a `ManagerConfig`, a legacy `MemberConfig`, and a
member `ExecutorEntity` runtime policy. Each target can use either
`{ kind: "alias", aliasId }` or `{ kind: "direct", provider }`, and the page
applies assignments through the production Web assignment helpers before saving
the draft to browser local storage.

## APIs

- `RuntimeProviderStatus.modelInventory` is provider-owned and required. It is
  either `{ state: "available", models }` or an explicit unavailable state.
- `GET /api/providers/inventory` returns a typed result:

```ts
{ ok: true, value: { backendId, providers } }
{ ok: false, error: { code, backendId, providerId?, message } }
```

An explicit `backendId` must match one exact Bridge connection. Missing
backends return `BACKEND_UNAVAILABLE`; a connected backend whose provider did
not publish inventory returns `PROVIDER_INVENTORY_UNAVAILABLE`. Neither case
borrows the local provider or model catalog.
- `POST /api/model-aliases/validate` validates a selection and alias list.
- `POST /api/model-aliases/resolve` validates and returns:

```ts
type ModelAliasResolveRequest = {
  backendId: string;
  modelSelection: ModelSelection;
  aliases?: ModelAlias[];
};

{ ok: true, backendId, resolved, provider: { providerId, ready } }
```

When `aliases` is omitted, Bridge may use built-in/default/local aliases. When
Web sends `aliases: []`, Bridge treats that as an explicit empty alias set, so
`{ kind: "alias", aliasId: "PrimaryModel" }` fails with
`MODEL_ALIAS_NOT_FOUND` unless Web includes that alias.

Failures return `{ ok: false, backendId, error, message, actions }`, where
`error` is one of `BACKEND_UNAVAILABLE`, `PROVIDER_INVENTORY_UNAVAILABLE`, `MODEL_ALIAS_NOT_FOUND`,
`PROVIDER_NOT_READY`, `PROVIDER_LOGIN_REQUIRED`, `MODEL_UNSUPPORTED`,
`REASONING_UNSUPPORTED`, or `SERVICE_TIER_UNSUPPORTED`, plus actions.

Codex owns its catalog at the runtime-provider adapter boundary. Local status
and daemon Remote publication serialize that same catalog. Remote Relay
transport maps `remote:<deviceId>` to that device's local backend for the
request and restores the remote backend id on the response.

Execute preflight returns `area: "model"` with the selected `backendId` for
inventory, alias, provider, model, reasoning, or service-tier failures. An
unknown selected backend remains an `area: "connection"` failure. Web maps the recommended action to
`/studio/settings/model-aliases`.

Execute and HUNSU Draft start requests both use the same `aliases?: ModelAlias[]`
field when Web sends custom alias definitions. Manager and Member configs may
store `modelSelection` as either a direct provider selection or an alias.

## Headless CLI

Use `hunsu-bridge model-alias`:

```sh
hunsu-bridge model-alias list
hunsu-bridge model-alias set PrimaryModel --model gpt-5.5-thinking --reasoning high --service-tier default
hunsu-bridge model-alias set ExperimentalModel --model vendor-new-model --reasoning high --experimental
hunsu-bridge model-alias validate PrimaryModel
hunsu-bridge model-alias override PrimaryModel --backend remote:device_123 --model gpt-5.5 --reasoning medium --service-tier fast
```

The daemon stores aliases in its configured state after an authenticated
control request. Web stores its current user aliases in browser local storage
and sends them with Execute and HUNSU Draft start requests.
