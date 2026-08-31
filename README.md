# OpenCode GSD Devcontainer

A VS Code development container for running [OpenCode](https://opencode.ai) with
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
| [OpenCode usage plugin](https://www.npmjs.com/package/@howaboua/opencode-usage-plugin) | Reports token usage and estimated model cost |
| [Council plugin](opencode-council-plugin/README.md) | Asks multiple model families to analyze the same request and synthesizes their responses |
| [GSD model profiles](opencode-gsd-models-plugin/README.md) | Routes GSD agents to appropriate models for each workload tier |
| [GSD](https://opengsd.net) | Autonomous planning, implementation, and verification |
| Browser tooling | Chromium, Playwright, agent-browser, and gsd-browser |
| [Tinfoil Proxy](https://tinfoil.sh) | Preinstalled proxy for accessing private models in trusted execution environments (TEEs) |
| Terminal tooling | tmux, the Skills CLI, and the agent-browser dogfood skill |

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

### Usage Reporting

The included [`@howaboua/opencode-usage-plugin`](https://www.npmjs.com/package/@howaboua/opencode-usage-plugin)
reports token usage and estimated cost for OpenCode sessions.

### GSD Model Profiles

Set `GSD_MODELS_PROFILE` to `claude`, `gpt`, or `mixed` before starting
OpenCode. If it is unset, the plugin selects a profile from detected provider
credentials or lets GSD agents inherit the session model.

```sh
GSD_MODELS_PROFILE=gpt opencode
```

Run `/gsd-models-profile` to report the active selection. The command does not
change configuration. See the
[GSD model profiles guide](opencode-gsd-models-plugin/README.md) for model
mappings and exact precedence.

### Model Council

Use `/council <prompt>` to ask the configured council members for independent
analysis and receive a synthesis of their agreement, disagreements, and
uncertainty.

The default council uses seven PPQ models. Each member call can add latency and
incur model cost. See the [council guide](opencode-council-plugin/README.md) to
change its members, quorum, or web access.

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
docker build -f opencode-gsd-models-plugin/test/Dockerfile opencode-gsd-models-plugin
```

## Publishing

GitHub Actions tests all plugins on pull requests. Pushes to `master` and tags
matching `v*` publish `linux/amd64` and `linux/arm64` images to GHCR. Use an
image digest for an immutable deployment.
