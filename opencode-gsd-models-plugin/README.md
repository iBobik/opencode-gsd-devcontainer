# OpenCode GSD Model Profiles Plugin

Routes `gsd-*` agents to models suited to their heavy, standard, or light work.
The plugin reads the routing tiers installed by GSD instead of duplicating
GSD's agent catalog, so newly installed GSD agents inherit their declared tier.

Only GSD agents receive model pins. Other OpenCode agents keep their existing
model selection. The plugin is already installed and configured in the OpenCode
GSD Devcontainer.

## Requirements

- OpenCode with support for local TypeScript plugins.
- `gsd-core` installed for OpenCode in the active OpenCode configuration
  directory.
- GSD configured with `model_profile: "inherit"` and
  `resolve_model_ids: "omit"`.

The devcontainer installs the GSD catalog and supplies these neutral defaults.
For a standalone installation, the project `.planning/config.json` must retain:

```json
{
  "model_profile": "inherit",
  "resolve_model_ids": "omit"
}
```

The plugin guards common attempts to change these settings to conflicting
values, but it cannot control changes made by external processes.

## Installation

From the repository root, copy the plugin into an OpenCode plugin directory.

For one project:

```sh
mkdir -p /path/to/project/.opencode/plugins
cp opencode-gsd-models-plugin/plugin/opencode-gsd-models.ts /path/to/project/.opencode/plugins/
```

For all projects:

```sh
mkdir -p ~/.config/opencode/plugins
cp opencode-gsd-models-plugin/plugin/opencode-gsd-models.ts ~/.config/opencode/plugins/
```

If `XDG_CONFIG_HOME` is set, use `$XDG_CONFIG_HOME/opencode/plugins/` instead of
`~/.config/opencode/plugins/`. Restart OpenCode after installing or updating the
plugin.

## Profiles

Set `GSD_MODELS_PROFILE` before starting OpenCode:

```sh
GSD_MODELS_PROFILE=gpt opencode
```

The current profile mappings are:

| Profile | Heavy | Standard | Light |
| --- | --- | --- | --- |
| `claude` | `anthropic/claude-opus-5` | `anthropic/claude-sonnet-5` | `anthropic/claude-haiku-4-5` |
| `gpt` | `openai/gpt-5.6-sol` | `openai/gpt-5.6-terra` | `openai/gpt-5.6-luna` |
| `mixed` | `ppq/claude-opus-5` | `ppq/gpt-5.6-sol` | `ppq/claude-haiku-4.5` |

Model IDs are provider catalog entries and may change as providers update their
catalogs.

## Selection Precedence

The plugin selects a profile in this order:

1. A non-empty `GSD_MODELS_PROFILE` process environment value.
2. `GSD_MODELS_PROFILE` in the worktree's `.env`.
3. `GSD_MODELS_PROFILE` in `.devcontainer/.env`.
4. A detected Anthropic credential, selecting `claude`.
5. A detected OpenAI credential, selecting `gpt`.
6. A detected PPQ credential, selecting `mixed`.
7. Session-model inheritance when no profile is selected.

The root `.env` is more specific and overrides `.devcontainer/.env`. The plugin
reads only `GSD_MODELS_PROFILE`; it does not source, create, or modify either
file.

Credential detection is a startup hint, not an authentication check. It uses
provider environment variables, OpenCode's stored authentication, or configured
API keys. OpenCode validates the credential later.

An invalid explicit value is ignored with a warning and does not fall through
to automatic provider selection. GSD agents inherit the session model in that
case. Restart OpenCode after changing the value.

## Status Command

Run:

```text
/gsd-models-profile
```

The command reports the active profile, its source, warnings, and manual switch
instructions. `/gsd-models-profile gpt` reports the requested name for context;
it does not switch profiles or change configuration.

## Catalog and Fallbacks

The plugin reads `gsd-core/bin/shared/model-catalog.json` from the active
OpenCode configuration directory. It uses each installed `gsd-*` agent's
`routingTier` to select the profile's heavy, standard, or light model.

If the catalog is missing, invalid, or unsafe, model pins are removed and GSD
agents inherit the session model. An installed GSD agent missing from the
catalog uses the standard tier.

After startup, the plugin checks whether the selected models appear in connected
provider catalogs and shows a TUI warning when they do not. It also shows TUI
warnings for detected authentication or quota failures. Startup, catalog, and
profile warnings are written to logs; TUI delivery is best effort in headless
sessions.

The plugin watches the two supported profile files and warns when either
changes, but profile changes take effect only after restarting OpenCode.

## Troubleshooting

- Agents inherit the session model: run `/gsd-models-profile` and check for an
  invalid profile or missing GSD catalog.
- A selected model is unavailable: connect the matching provider, choose another
  profile, and restart OpenCode.
- Automatic selection chooses an unusable provider: set an explicit profile or
  repair the detected credential.
- GSD configuration changes are blocked: keep `model_profile` set to `inherit`
  and `resolve_model_ids` set to `omit`.

## Test

From the repository root, run:

```sh
docker build -f opencode-gsd-models-plugin/test/Dockerfile opencode-gsd-models-plugin
```

The Docker build tests profile parsing and routing, configuration guards,
fallback behavior, and plugin loading with the official OpenCode image. It does
not validate live provider catalogs or make paid model calls.
