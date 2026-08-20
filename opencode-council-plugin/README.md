# OpenCode Council Plugin

Adds a universal, read-only multi-model council command to OpenCode:

```text
/council <prompt>
```

The command runs a hidden orchestrator as a subtask. It sends one identical,
self-contained prompt to each configured member in parallel through OpenCode's
native Task tool, then returns a synthesis with consensus, disagreements,
unique observations, uncertainty, and any failed members.

## Why Use a Model Council?

Consulting models from different families can give the council complementary
perspectives. Their training data, training objectives, alignment policies, and
guardrails can differ, producing distinct strengths, blind spots, and failure
modes. Evidence-backed agreement is therefore more useful, and disagreement is
worth surfacing. This does not guarantee independence or correctness: assess the
evidence rather than relying on majority vote.

## Defaults

The built-in council uses PPQ model identifiers (`ppq/...`) for Claude, GPT,
Gemini, Qwen, Kimi, GLM, and Grok. PPQ is the simplest way to access these model
families through one OpenCode provider configuration and one authentication
flow, rather than setting up a separate provider and credential for each family.
Install and authenticate the [OpenCode PPQ Plugin](../opencode-ppq-plugin/README.md)
before using the defaults.

## Configuration

You can provide your own member list, including models configured through
providers other than PPQ.

Configuration is merged in this order:

1. Built-in defaults.
2. `~/.config/opencode/council.json`.
3. `.opencode/council.json` in the active worktree.

Each higher-level file can override `members`, `minimum_successful_members`, or
`allow_web`. Invalid files are ignored and the last valid configuration remains
active.

When a configuration overrides `members` without specifying
`minimum_successful_members`, the inherited minimum is capped at the new member
count. An explicitly invalid minimum still makes that configuration invalid.

```json
{
  "members": [
    { "name": "claude", "model": "ppq/claude-fable-5" },
    { "name": "gemini", "model": "ppq/~google/gemini-pro-latest" }
  ],
  "minimum_successful_members": 2,
  "allow_web": true
}
```

Council members can read files, search files, use LSP, and optionally fetch or
search the web. They cannot edit files, run shell commands, delegate tasks, or
ask separate user questions.

`minimum_successful_members` controls when the orchestrator labels an
observation as consensus. It is a best-effort synthesis policy: OpenCode's Task
tool does not expose structured completion results to this config-only plugin,
so a response is still returned when the quorum is not met and identifies that
condition.

The council orchestrator delegates to member agents, which requires a subagent
depth of two. The plugin raises `subagent_depth` to at least `2` when loaded;
higher configured values are preserved.
