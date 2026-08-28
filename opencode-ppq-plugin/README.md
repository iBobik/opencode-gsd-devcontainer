# OpenCode PPQ Plugin

Adds [PPQ](https://ppq.ai) to OpenCode as a model provider. The plugin creates
the provider, integrates with `/connect`, and imports model capabilities and
pricing from PPQ's live catalog.

This avoids maintaining a static model list as PPQ adds or changes models. The
plugin is already installed in the OpenCode GSD Devcontainer.

## Requirements

- OpenCode with support for local TypeScript plugins.
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
`~/.config/opencode/plugins/`. Restart OpenCode after installing or updating the
plugin.

The plugin creates the `ppq` provider automatically. Provider configuration is
optional and is only needed to override its defaults. For example:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "ppq": {
      "options": {
        "includeUsage": true
      }
    }
  }
}
```

## Connect

1. Start OpenCode.
2. Run `/connect`.
3. Select PPQ.
4. Open [PPQ](https://ppq.ai/invite/a586e70a), add funds, and create an API key.
5. Paste the key into OpenCode.
6. Restart OpenCode to load the catalog.

You can also set `PPQ_API_KEY` before starting OpenCode:

```sh
PPQ_API_KEY=your-key opencode
```

Credentials are resolved in this order:

1. `PPQ_API_KEY` exported in the process environment.
2. The PPQ key stored by OpenCode in `$XDG_DATA_HOME/opencode/auth.json`, or
   `~/.local/share/opencode/auth.json` when `XDG_DATA_HOME` is unset.
3. `provider.ppq.options.apiKey` in OpenCode configuration.

Prefer environment or stored credentials over placing a key in configuration.

## Catalog and Cache

After finding a credential, the plugin requests `https://api.ppq.ai/v1/models`
without sending the credential. It maps the returned context limits,
modalities, tool support, reasoning support, and token prices into OpenCode's
model configuration.

The catalog is cached for ten minutes at
`$XDG_DATA_HOME/opencode/ppq-models.cache.json`, or
`~/.local/share/opencode/ppq-models.cache.json` when `XDG_DATA_HOME` is unset.
If a refresh fails, the plugin uses an older valid cache when available. Without
a credential, or when no catalog or cache can be loaded, PPQ shows one
`sign-in-required` model with instructions instead of an unusable model list.

Static models declared in `provider.ppq.models` are preserved and take
precedence over catalog entries with the same ID.

## Troubleshooting

- Only `sign-in-required` appears: connect PPQ and restart OpenCode.
- A key set only in a project `.env` file is ignored: OpenCode does not read
  `.env` files. Export `PPQ_API_KEY` in the shell or store the key with
  `/connect`.
- The catalog does not refresh: wait ten minutes, remove the cache, or restart
  after checking network access to `api.ppq.ai`.
- A configured key is ignored: `PPQ_API_KEY` and OpenCode's stored credential
  take precedence.
- Inference fails after models load: verify that the key is valid and the PPQ
  account has funds.

## Test

From the repository root, run:

```sh
docker build -f opencode-ppq-plugin/test/Dockerfile opencode-ppq-plugin
```

The Docker build tests credential precedence, catalog normalization, cache
fallback, sign-in behavior, and plugin loading with the official OpenCode image.
It does not make paid model calls.
