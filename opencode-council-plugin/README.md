# OpenCode Council Plugin

Adds a read-only, multi-model council command to OpenCode:

```text
/council <prompt>
```

The plugin asks models from different families to analyze the same request and
then synthesizes their agreement, disagreements, unique observations, and
uncertainty.

It is already installed in the OpenCode GSD Devcontainer.

## Why Use a Model Council?

Model families can have different strengths, blind spots, training objectives,
and guardrails. Comparing their evidence can expose alternatives that one model
misses. Agreement is not proof, however, and majority vote does not guarantee a
correct answer.

## Requirements

- OpenCode with support for local TypeScript plugins.
- Access to every configured model.
- The [OpenCode PPQ Plugin](../opencode-ppq-plugin/README.md) when using the
  built-in PPQ members.

## Installation (not using Docker image)

From the repository root, copy the plugin into an OpenCode plugin directory.

For one project:

```sh
mkdir -p /path/to/project/.opencode/plugins
cp opencode-council-plugin/plugin/opencode-council.ts /path/to/project/.opencode/plugins/
```

For all projects:

```sh
mkdir -p ~/.config/opencode/plugins
cp opencode-council-plugin/plugin/opencode-council.ts ~/.config/opencode/plugins/
```

If `XDG_CONFIG_HOME` is set, use `$XDG_CONFIG_HOME/opencode/plugins/` instead of
`~/.config/opencode/plugins/`. Restart OpenCode after installing or updating the
plugin.

## Quick Start

The default members use PPQ. Install and authenticate the PPQ plugin, restart
OpenCode, then run:

```text
/council Review this design and identify its main risks.
```

One request can invoke every configured member plus the orchestrator. A failed
or empty member response is retried once, which can further increase latency and
model cost.

## Defaults

The built-in council uses these current PPQ model IDs:

| Member | Model |
| --- | --- |
| Claude | `ppq/claude-fable-5` |
| GPT | `ppq/gpt-5.6-sol` |
| Gemini | `ppq/~google/gemini-pro-latest` |
| Qwen | `ppq/qwen/qwen3.8-max` |
| Kimi | `ppq/moonshotai/kimi-k3` |
| GLM | `ppq/glm-5.3` |
| Grok | `ppq/grok-4.6` |

The default minimum for consensus is two successful members. Web access is
enabled for members by default.

## Configuration

Configuration is merged from least to most specific:

1. Built-in defaults.
2. `$XDG_CONFIG_HOME/opencode/council.json`, or
   `~/.config/opencode/council.json` when `XDG_CONFIG_HOME` is unset.
3. `.opencode/council.json` in the active worktree.

Each later file can override `members`, `minimum_successful_members`, or
`allow_web`:

```json
{
  "members": [
    { "name": "claude", "model": "ppq/claude-fable-5" },
    { "name": "gemini", "model": "ppq/~google/gemini-pro-latest" }
  ],
  "minimum_successful_members": 2,
  "allow_web": false
}
```

Configuration rules:

- `members` must contain 1 to 12 entries.
- Names must start with a letter or number and contain only letters, numbers,
  and hyphens. Names are unique without regard to case.
- Each model must use a `provider/model` ID, and model IDs cannot be repeated.
- `minimum_successful_members` must be an integer from `1` through the member
  count.
- `allow_web` must be `true` or `false`.

When `members` changes without an explicit minimum, the inherited minimum is
capped at the new member count. An invalid file is ignored and a warning is
written to the OpenCode log. Restart OpenCode after changing configuration.

## How It Works

The plugin creates one hidden, model-pinned agent for each member and a hidden
orchestrator. The orchestrator is instructed to submit all member Task calls in
one assistant message so OpenCode can run them concurrently, then wait for the
results. It retries explicit failures and empty responses once in a second
parallel round, using fresh sessions. When a response contains useful findings
but stopped early, such as after reaching its step limit, the retry receives the
original request and the full partial response. It is instructed to continue
the unfinished work without repeating completed investigation or a known
problematic tool call. The orchestrator then produces one response from all
available evidence. Complete members are not retried, and failed retries are
not attempted again.

`minimum_successful_members` controls when the response labels an observation
as consensus. It is not a completion gate: if fewer members return successfully,
the orchestrator still responds with the available evidence and identifies that
the quorum was not met.

Council members can read and search project files and use LSP. When `allow_web`
is enabled, they can also fetch and search the web. They cannot edit files, run
shell commands, delegate tasks, access external directories, or ask separate
questions. The orchestrator can only delegate to council member agents.

Members are limited to 12 agentic iterations. The orchestrator also has a
bounded iteration budget based on the council size. OpenCode's repeated
identical-tool-call guard is denied automatically for both agent types, so a
stuck call fails instead of waiting for user approval. That failure is eligible
for the orchestrator's single fresh retry. Useful partial results are retained
for synthesis even if their continuation attempt also fails.

The nested delegation requires a subagent depth of two. The plugin raises
`subagent_depth` to at least `2` and preserves higher configured values.

## Privacy and Cost

The request is sent to every configured model provider. Project content read by
a member may also be included in that provider request. Disable web access or
choose fewer members when privacy, latency, or cost is more important than model
diversity.

## Troubleshooting

- A member fails: verify that its provider is connected and its model ID is
  available.
- The defaults fail: install the PPQ plugin, connect PPQ, and restart OpenCode.
- Configuration has no effect: check the OpenCode log for a validation warning
  and restart after correcting the file.
- Responses are too slow or expensive: configure fewer members and lower the
  minimum accordingly.
- A member repeatedly calls the same tool: OpenCode stops the repeated call and
  the orchestrator retries that member once in a fresh session.

## Test

From the repository root, run:

```sh
docker build -f opencode-council-plugin/test/Dockerfile opencode-council-plugin
```

The Docker build tests configuration, permissions, step limits, retry policy,
agent registration, and plugin loading with the official OpenCode image. It
does not call live models or guarantee provider-side concurrency.
