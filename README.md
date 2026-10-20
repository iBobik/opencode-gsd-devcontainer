# OpenCode GSD Devcontainer

A VS Code development container for running [OpenCode 2](https://opencode.ai/v2/docs/) with
[GSD](https://opengsd.net), multi-provider model routing, a read-only model
council, usage reporting, and browser automation.

```text
ghcr.io/ibobik/opencode-gsd-devcontainer:latest
```

The image tracks the latest upstream releases. Use an image digest
when you need reproducible builds.

## Included

| Component | Purpose |
| --- | --- |
| [OpenCode](https://opencode.ai) | Provider-agnostic coding-agent runtime |
| [PPQ provider plugin](opencode-ppq-plugin/README.md) | Adds the live [PPQ](https://ppq.ai) model catalog and authentication |
| [OpenCode Quota](https://www.npmjs.com/package/@slkiser/opencode-quota) | Quota sidebar, token/cost reports, and retry after quota resets |
| [Council plugin](opencode-council-plugin/README.md) | Asks multiple model families to analyze the same request and synthesizes their responses |
| [GSD](https://opengsd.net) | Autonomous planning, implementation, and verification |
| Browser tooling | Chromium, Playwright, agent-browser, and gsd-browser |
| [Tinfoil Proxy](https://tinfoil.sh) | Preinstalled proxy for accessing private models in trusted execution environments (TEEs) |
| Terminal tooling | GitHub CLI, tmux, the Skills CLI, and the agent-browser dogfood skill |

## Quick Start

You need Docker and VS Code with the Dev Containers extension.

From your project root, download the dev container template:

```sh
curl -fsSL --create-dirs -o .devcontainer/devcontainer.json https://raw.githubusercontent.com/ibobik/opencode-gsd-devcontainer/master/template/.devcontainer/devcontainer.json -o .devcontainer/.gitignore https://raw.githubusercontent.com/ibobik/opencode-gsd-devcontainer/master/template/.devcontainer/.gitignore
```

Open the project in VS Code and choose **Reopen in Container**, then start
OpenCode:

```sh
opencode
```

Run `/connect` to add a model provider. For PPQ, select PPQ and paste an API
key.

The template persists OpenCode authentication and sessions under
`.devcontainer/data/`. Its local `.gitignore` excludes that directory.

## Features

### PPQ Models

The PPQ plugin loads the current PPQ catalog after authentication and caches it
for startup resilience. See the [PPQ plugin guide](opencode-ppq-plugin/README.md)
for installation, credential precedence, and failure behavior.

### Quota and Usage Reporting

The included [`@slkiser/opencode-quota`](https://www.npmjs.com/package/@slkiser/opencode-quota)
provides a quota sidebar and `/quota`, `/quota_status`, `/tokens_session`, and
other token/cost reports. Provider detection is automatic. When a provider hits
a limit and its quota window is exhausted, **wait-for-reset is enabled** so
OpenCode can retry after the reset. PPQ-specific balance reporting is not configured.

Settings are baked into
`~/.config/opencode/opencode-quota/quota-toast.json`. The sidebar is enabled;
automatic popup toasts and the compact status line are disabled.

### GSD Model Profiles Removed

The `opencode-gsd-models-plugin` has been removed and is no longer bundled.
`GSD_MODELS_PROFILE` and `/gsd-models-profile` are no longer supported by this
image. GSD agents inherit the session model with the supplied defaults.
See the [GSD Core model profiles documentation](https://github.com/open-gsd/gsd-core/blob/main/docs/CONFIGURATION.md#model-profiles)
for GSD's built-in profile configuration.

### Model Council

Use `/council <prompt>` to ask the configured council members for independent
analysis and receive a synthesis of their agreement, disagreements, and
uncertainty.

The default council uses seven PPQ models. Each member call can add latency and
incur model cost. See the [council guide](opencode-council-plugin/README.md) to
change its members, quorum, or web access.

## Upgrading from OpenCode 1

Rebuild the devcontainer to install `@opencode/cli` (OpenCode 2) and the migrated
plugins. The development environment's setup installs the v2 CLI on rebuild.
GSD-Core's upstream v2 adapter is included;
the removed GSD-models plugin is not restored.

Back up `.devcontainer/data/` before first opening existing v1 data with v2.
Both generations share data locations, and v1 cannot necessarily reopen a v2-used
database. V2 owns provider connections; reconnect with `/connect` if an old login
is not available. The PPQ plugin uses v2 integration APIs rather than reading
`auth.json` directly.

After changing configuration, plugins, or environment variables, quit OpenCode,
run `opencode service stop`, then start `opencode` again. A running background
service retains its loaded configuration and environment.

## Browser Security

Browser tools use the system Chromium binary with `--no-sandbox`,
`--disable-gpu`, and `--disable-dev-shm-usage` for container compatibility.
Treat browser sessions as untrusted and do not expose credentials or sensitive
sites that the agent should not access.

## Build and Test

Build the image locally:

```sh
docker build -t opencode-gsd-devcontainer:local .
```

Set the template image to `opencode-gsd-devcontainer:local` to use that build.

Run the plugin test suites from the repository root:

```sh
docker build -f opencode-ppq-plugin/test/Dockerfile opencode-ppq-plugin
docker build -f opencode-council-plugin/test/Dockerfile opencode-council-plugin
```

Each plugin build runs behavioral tests, typechecks its implementation, and loads
it in the official OpenCode 2 image. The full-image build checks CLI installation
and GSD assets, but does not exercise the combined plugin configuration.

For an authenticated check after rebuilding: connect PPQ, confirm its live models
in `/models`, run `/council` and `/council-last` in the same conversation, open
`/gsd-help`, and inspect `/quota_status` and `/tokens_session` after a model request.

## Publishing

GitHub Actions tests all plugins on pull requests. Pushes to `master` and tags
matching `v*` publish `linux/amd64` and `linux/arm64` images to GHCR. Use an
image digest for an immutable deployment.
