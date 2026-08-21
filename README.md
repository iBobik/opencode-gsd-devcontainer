# OpenCode GSD Devcontainer

A rolling devcontainer image with OpenCode, GSD-Core, GSD-pi, the PPQ provider
plugin, a seven-member read-only model council, and browser tooling.

```text
ghcr.io/ibobik/opencode-gsd-devcontainer:latest
```

## Included

- [OpenCode]() with the [PPQ.ai]() provider plugin. After authentication it exposes the live
  PPQ catalog with all model families on the market.
- `/council <prompt>`, which asks seven different models in parallel and
  synthesizes their answers.
- [GSD](https://opengsd.net) (gsd-core, gsd-pi and gsd-browser) for autonomous development
- Chromium, Playwright, agent-browser, gsd-browser, tmux, and the agent-browser
  dogfood skill.
- `tinfoil-proxy` for access to the private TEE models

The image intentionally tracks the latest upstream package versions. Each build
runs installation smoke checks, while plugin behavior is tested in GitHub Actions.

## Use In A Project

Copy the supplied template into a project, then reopen it in VS Code:

```sh
cp -R template/.devcontainer /path/to/project/.devcontainer
```

The template persists OpenCode authentication and sessions in
`.devcontainer/data/`, which is ignored by its local `.gitignore`.

To build the image locally instead:

```sh
docker build -t opencode-gsd-devcontainer:local .
```

Set the template image to `opencode-gsd-devcontainer:local` for local testing.

## PPQ Authentication

Run `/connect`, choose PPQ, and paste an API key. OpenCode stores it at:

```text
$XDG_DATA_HOME/opencode/auth.json
```

The template sets `XDG_DATA_HOME` to persistent workspace storage. Alternatively,
set `PPQ_API_KEY` in the container environment. An environment key takes precedence
over stored and configured credentials. Restart OpenCode after interactive setup so
the plugin can load the catalog.

The catalog is cached for ten minutes for offline resilience. When no credential is
available, PPQ shows one sign-in model rather than an unusable full catalog.

## GSD Model Profiles

GSD subagents can use one of three provider profiles without changing project
configuration:

| Profile | Heavy | Standard | Light |
| --- | --- | --- | --- |
| `claude` | Claude Opus 5 | Claude Sonnet 5 | Claude Haiku 4.5 |
| `gpt` | GPT 5.6 Sol | GPT 5.6 Terra | GPT 5.6 Luna |
| `mixed` | PPQ Claude Opus 5 | PPQ GPT 5.6 Sol | PPQ Claude Haiku 4.5 |

Set `GSD_MODELS_PROFILE` before starting OpenCode. A process environment value
wins over a repository-local `.env` or `.devcontainer/.env`; otherwise the image selects an
authenticated Anthropic, OpenAI, then PPQ provider. If none is available, GSD
agents inherit the session model.

```sh
GSD_MODELS_PROFILE=gpt opencode
```

Alternatively, add this manually to the ignored repository `.env`:

```dotenv
GSD_MODELS_PROFILE=gpt
```

Restart OpenCode after changing it. No image rebuild or container reopen is
needed. The plugin reads only this one `.env` key and never creates or edits the
file. `/gsd-models-profile [name]` reports the active selection and these manual
switching options; it does not change configuration.

GSD is installed with neutral `model_profile: "inherit"` and
`resolve_model_ids: "omit"`; the plugin applies model pins only to GSD agents.
It warns in the TUI and headless logs when a selected provider/model is not
connected, `.env` changes, or a GSD agent hits an authentication or quota error.

## Model Council

The default members are Claude Fable, GPT Sol, Gemini Pro, Qwen Max, Kimi K3, GLM,
and Grok. Configure a different member list, quorum, or web access in either:

```text
~/.config/opencode/council.json
.opencode/council.json
```

Project configuration takes precedence. See
[`opencode-council-plugin/README.md`](opencode-council-plugin/README.md) for the
schema. Each member call can incur model cost.

## Browser Notes

The image uses the system Chromium binary for browser tooling. Chromium is launched
with `--no-sandbox`, `--disable-gpu`, and `--disable-dev-shm-usage` for container
compatibility. Treat browser sessions as untrusted and do not browse sensitive sites
with credentials you do not intend the agent to access.

## Publishing

GitHub Actions runs all plugin test suites on pull requests. Pushes to `main` and
version tags publish multi-architecture `linux/amd64` and `linux/arm64` images to
GHCR. Pull the tag you need, or use an image digest when you need an immutable
deployment.
