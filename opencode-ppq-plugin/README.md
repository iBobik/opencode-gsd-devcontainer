# OpenCode PPQ Plugin

Adds [PPQ](https://ppq.ai) to OpenCode as a model provider. The plugin creates
the provider, integrates with `/connect`, and imports model capabilities and
pricing from PPQ's live catalog.

This avoids maintaining a static model list as PPQ adds or changes models. The
plugin is already installed in the OpenCode GSD Devcontainer.

## Requirements

- OpenCode 2.1.1 or newer with support for local TypeScript plugins.
- A funded PPQ account and API key to run models. You can create one through
  [PPQ](https://ppq.ai/invite/a586e70a).

Listing the catalog is public, but the plugin waits for a credential before
showing the full catalog so unavailable models do not fill the model picker.

## Installation

From the repository root, copy the plugin into an OpenCode plugin directory.

For one project:

```sh
mkdir -p /path/to/project/.opencode/plugins
cp opencode-ppq-plugin/plugin/opencode-ppq.ts /path/to/project/.opencode/plugins/
```

For all projects:

```sh
mkdir -p ~/.config/opencode/plugins
cp opencode-ppq-plugin/plugin/opencode-ppq.ts ~/.config/opencode/plugins/
```

If `XDG_CONFIG_HOME` is set, use `$XDG_CONFIG_HOME/opencode/plugins/` instead of
`~/.config/opencode/plugins/`. After installing or updating, quit OpenCode,
run `opencode service stop`, and restart OpenCode.

The plugin creates the `ppq` provider automatically. Provider configuration is
optional and is only needed to override its defaults, such as endpoint or timeout
settings. No `providers` block is required for authentication, model discovery,
or usage reporting.

## Connect

1. Start OpenCode.
2. Run `/connect`.
3. Select PPQ.
4. Open [PPQ](https://ppq.ai/invite/a586e70a), add funds, and create an API key.
5. Paste the key into OpenCode.
6. The catalog reloads after connecting or switching credentials.

You can also set `PPQ_API_KEY` before starting OpenCode:

```sh
PPQ_API_KEY=your-key opencode
```

Credentials are resolved in this order:

1. `PPQ_API_KEY` exported in the process environment.
2. The active PPQ connection stored by OpenCode 2, resolved through its integration API.
3. `providers.ppq.settings.apiKey` in OpenCode configuration.

Prefer environment or stored credentials over placing a key in configuration.

## Catalog and Cache

After finding a credential, the plugin requests `https://api.ppq.ai/v1/models`
without sending the credential. It maps the returned context limits,
modalities, tool/temperature support, and token prices into OpenCode's v2 model
definitions. Reasoning controls are handled by the selected provider/model protocol.

The catalog is cached for ten minutes at
`$XDG_DATA_HOME/opencode/ppq-models.cache.json`, or
`~/.local/share/opencode/ppq-models.cache.json` when `XDG_DATA_HOME` is unset.
If a refresh fails, the plugin uses an older valid cache when available. Without
a credential, or when no catalog or cache can be loaded, PPQ shows one
`sign-in-required` model with instructions instead of an unusable model list.

Static models declared in `providers.ppq.models` are preserved and take
precedence over catalog entries with the same ID.

## Usage and Cost

OpenCode 2's OpenAI-compatible runtime requests streaming usage automatically.
When PPQ returns usage, OpenCode records input, output, reasoning, and cache-token
counts in the assistant message and session totals. The plugin supplies prices
from PPQ's catalog so OpenCode can calculate estimated costs. No separate usage
hook or `compatibility.streamUsage` setting is needed.

Reported counts depend on what PPQ and the upstream model return. If usage is
absent, the plugin does not estimate or fabricate token counts. Cache prices are
currently set to zero because the catalog mapping does not supply cache rates;
estimated cost is not an authoritative PPQ invoice or account balance.

Use OpenCode's usage display, or `/tokens_session` when OpenCode Quota is installed,
to inspect the recorded usage. PPQ account-balance and quota reporting are not
provided by this plugin.

## Troubleshooting

- Only `sign-in-required` appears: connect PPQ and check catalog connectivity.
  If needed, stop the background service and restart OpenCode.
- A key set only in a project `.env` file is ignored: OpenCode does not read
  `.env` files. Export `PPQ_API_KEY` in the shell or store the key with
  `/connect`.
- The catalog does not refresh: wait ten minutes, remove the cache, or restart
  after checking network access to `api.ppq.ai`.
- A configured key is ignored: `PPQ_API_KEY` and OpenCode's stored credential
  take precedence.
- A newly exported key has no effect: stop the background service before restarting
  so it receives the new environment.
- Inference fails after models load: verify that the key is valid and the PPQ
  account has funds.

## Test

From the repository root, run:

```sh
docker build -f opencode-ppq-plugin/test/Dockerfile opencode-ppq-plugin
```

The Docker build tests credential precedence, catalog normalization, cache
fallback, sign-in behavior, and plugin loading with the official OpenCode image.
It also verifies settings-only authentication in an isolated data directory.
An integration test runs simulated streaming responses through the real runtime
without provider configuration, checks persisted message/session token counts
and costs, and covers missing usage. It uses a local endpoint and fake credential;
it does not make paid model calls.
