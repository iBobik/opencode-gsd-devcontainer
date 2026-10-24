# OpenCode Council Plugin

Adds a read-only, multi-model council command to OpenCode:

```text
/council <prompt>
/council-last [question or continuation request]
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

## Features

- **Conversation-aware requests:** The orchestrator receives up to 20 recent
  user and assistant text messages, capped at 24,000 characters, so requests
  such as `/council review it` can refer to the current conversation. It turns
  the request and relevant context into one self-contained task for the council.
- **Independent investigation:** Every member receives the same task but
  independently decides which project files or web sources are material to its
  analysis. This preserves diversity in both reasoning and evidence gathering.
- **Read-only operation:** Members can read and search the project and
  optionally access the web, but cannot modify files or run shell commands.
- **Parallel multi-model analysis:** Model-pinned members work concurrently and
  do not see or conform to one another's responses.
- **Visible progress and results:** A compact status line above the composer
  shows member counts, retries, and synthesis progress. It disappears when the
  report is delivered. If delivery is unconfirmed, a recovery notice remains.
  The report appears once as a conversation notice, without waking
  the main model. Your next reply gives the main model both the report and your
  reply. OpenCode 2.1.1 renders synthetic notices as plain text, not Markdown;
  its public plugin API cannot insert an ordinary assistant message or native
  inline subagent activity. Those presentation improvements require upstream
  support; the plugin does not make an extra model call to repeat the report.
- **Summarized session naming:** When council starts an empty, untitled
  conversation, it generates a short title from the council prompt using
  OpenCode's configured `title` agent instructions and model (the parent model
  when no title model is configured). This uses OpenCode's public, tool-free
  text-generation API; V2.1.1 does not expose its automatic title trigger to
  plugins. A prompt-based title is shown first and kept if generation fails or
  exceeds a local ten-second deadline. This stops waiting even when the V2.1.1
  adapter ignores request signals; the underlying provider request may continue
  and incur charges. Follow-ups, later councils, and manual renames do not
  replace the title. Titles are capped at 100 characters.
- **Evidence-based synthesis:** The orchestrator weighs evidence over majority
  count and reports consensus, disagreements, unique observations, uncertainty,
  and failed members.
- **Bounded retries:** Failed, empty, or incomplete member responses receive at
  most one fresh retry while useful partial findings remain available for the
  final synthesis.
- **Saved reports:** `/council-last` without arguments shows the exact saved
  successfully completed synthesis without invoking a model, including after
  report delivery failed. Interrupted or failed partial output does not bypass
  member-response recovery.
- **Recovery after interruption:** `/council-last <request>` reads the persisted member
  sessions from the latest council run in the current conversation. It makes
  completed, partial, and failed attempts available to the current main agent,
  including after OpenCode has restarted.

## Requirements

- OpenCode 2.1.1 or newer with support for local TypeScript plugins.
- Access to every configured model.
- The [OpenCode PPQ Plugin](../opencode-ppq-plugin/README.md) when using the
  built-in PPQ members.

## Installation (not using Docker image)

From the repository root, copy the plugin into an OpenCode plugin directory.

For one project:

```sh
mkdir -p /path/to/project/.opencode/plugins
cp -R opencode-council-plugin /path/to/project/.opencode/plugins/council
```

For all projects:

```sh
mkdir -p ~/.config/opencode/plugins
cp -R opencode-council-plugin ~/.config/opencode/plugins/council
```

If `XDG_CONFIG_HOME` is set, use `$XDG_CONFIG_HOME/opencode/plugins/` instead of
`~/.config/opencode/plugins/`. Run `/reload` after installing or updating.
When upgrading a single-file installation, remove the old `opencode-council.ts`
plugin after installing the directory to avoid loading two copies. Keep the root
`tui.ts` file: local directory plugins resolve that entrypoint directly, even
when `package.json` also exports `./tui`.

The image sets `experimental.subagent_depth` to `2` for nested council calls.
For a standalone install, set it to at least `2` in `opencode.json` (preserve a
higher value if you already use one):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "experimental": { "subagent_depth": 2 }
}
```

## Quick Start

The default members use PPQ. Install and authenticate the PPQ plugin, restart
OpenCode, then run:

```text
/council Review this design and identify its main risks.
```

If the council was interrupted, reopen the same parent conversation and run:

```text
/council-last
```

This shows the saved synthesis without a model call when one is available;
otherwise it recovers member responses using the main agent. An argument always
asks the current main agent a specific question or tells it how to continue:

```text
/council-last Which risks were supported by evidence from at least two members?
/council-last Continue the implementation using the recovered findings.
```

## Defaults

The built-in council uses these current PPQ model IDs:

| Member | Model |
| --- | --- |
| Claude | `ppq/claude-opus-5.5` |
| GPT | `ppq/gpt-6.1-sol` |
| Gemini | `ppq/google/gemini-4-argon` |
| Qwen | `ppq/qwen/qwen3.8-max-prime` |
| Kimi | `ppq/moonshotai/kimi-k3.1-pro` |
| GLM | `ppq/z-ai/glm-5.3-prime` |
| Grok | `ppq/x-ai/grok-4.7` |

The default minimum for consensus is two successful members. Web access is
enabled for members by default.

## Configuration

Configuration is merged from least to most specific:

1. Built-in defaults.
2. `council.json` beside the active global config, honoring `OPENCODE_CONFIG_DIR`,
   `OPENCODE_CONFIG`, `XDG_CONFIG_HOME`, then `~/.config/opencode/`.
3. `.opencode/council.json` in the active worktree.

Each later file can override `members`, `minimum_successful_members`,
`allow_web`, or `member_steps`:

```json
{
  "members": [
    { "name": "claude", "model": "ppq/claude-opus-5.5", "steps": 40 },
    { "name": "gemini", "model": "ppq/google/gemini-4-argon" }
  ],
  "minimum_successful_members": 2,
  "allow_web": false,
  "member_steps": 30
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
- `member_steps` defaults to `30` and must be an integer from `1` through `100`.
  A member's optional `steps` uses the same range and overrides `member_steps`
  for that member. The budget applies separately to each initial or retry attempt.

When `members` changes without an explicit minimum, the inherited minimum is
capped at the new member count. An invalid file is ignored and a warning is
written to the OpenCode log. Restart OpenCode after changing configuration.

Before starting `/council`, the plugin checks every member against OpenCode's
loaded provider catalog. If any model or provider is missing, the command stops
with a list of unavailable members before launching tasks. Use exact IDs from
`/models`: `ppq/` is the provider prefix, and everything after it must match the
PPQ model ID, including any vendor prefix present in the catalog. Defaults are
fixed IDs; the plugin does not silently substitute another model.

## How It Works

The plugin creates one hidden, model-pinned agent for each member and a hidden
orchestrator. `/council` creates an orchestrator child using the parent session's
model and location. The orchestrator submits all member `subagent` calls in
one assistant message so OpenCode can run them concurrently, then wait for the
results. It retries explicit failures and empty responses once in a second
parallel round, using fresh sessions. When a response contains useful findings
but stopped early, such as after reaching its step limit, the retry receives the
original request and the full partial response. It is instructed to continue
the unfinished work without repeating completed investigation or a known
problematic tool call. The orchestrator then produces one response from all
available evidence. Complete members are not retried, and failed retries are
not attempted again. Its final synthesis is posted back to the parent as a
non-resuming report, without another model call. Interrupting the parent cancels
council startup as well as active children; plugin cleanup cancels pending and
active runs and its event subscription. If interruption races child creation,
the returned child is interrupted before it receives a prompt.

V2 admits that report to the session inbox for the next model turn. A separate
CLI entrypoint displays a compact live status line above the composer, not a
second copy of the report. A terminal recovery notice remains when delivery is
unconfirmed. Display state is persisted best-effort per invocation; storage
failures do not block startup or report admission. Each invocation owns a separate
record, and readers select the newest by immutable creation order, so delayed
heartbeats, completion, cleanup, or recovery from another instance cannot hide a
newer run. This does not enforce cross-instance single-run exclusivity.
Recovery-only notices are stored separately and shown only when no invocation
display exists; even a notice written during delayed startup cannot outrank a run.
Progress polls actual member sessions once per second while mounted; it does not call a
model. Polls target the session's location and read durable display state plus
the actual orchestrator outcome, not a location-specific plugin instance's
in-memory ownership map. A different instance must not label an active run as
stopped or serve a cached report from an earlier run.
Clients without the CLI entrypoint do not show this live status line; the
synthetic report also carries its full text as its visible description rather
than an opaque “Council report” label. Its model-visible text remains available
on the next turn.

Deleting a conversation removes its display state. Status reads verify the
parent still exists before returning stored text, and plugin loading scans
saved displays to remove orphaned entries. Transient lookup errors do not erase
saved data. All running records have a refreshed 30-second lease, including after
the orchestrator ID is saved. An expired lease stops displaying running even if
the orchestrator has no outcome; it does not prove every child has stopped.
Cleanup saves interruption independently of conversation-message delivery.
Repeated `/council` commands and `/council-last` during an active local run
return an explicit notice without replacing its progress. Recovery errors and
missing responses are labeled separately from successful completion.

OpenCode persists the orchestrator and members as nested child sessions.
When reconstructing member responses, `/council-last` locates the newest orchestrator in the current parent session
that has council member children, then reads every member attempt, including
fresh retry sessions. No plugin-specific recovery state is required, so saved
responses remain recoverable after a process restart. Visible user and assistant
text is restored; reasoning, tool output, synthetic text, and ignored text are
excluded. Recovered text is treated as quoted, untrusted source material.

Recovery is limited to the current parent conversation. If OpenCode restarts,
reopen that conversation before using `/council-last`. Very large recovered
transcripts are capped at 96,000 characters and visibly marked where truncated.

`minimum_successful_members` controls when the response labels an observation
as consensus. It is not a completion gate: if fewer members return successfully,
the orchestrator still responds with the available evidence and identifies that
the quorum was not met.

Council members can read and search project files. When `allow_web`
is enabled, they can also fetch and search the web. They cannot edit files, run
shell commands, delegate tasks, access external directories, or ask separate
questions. The orchestrator can only delegate to council member agents.

Members default to 30 agentic iterations, configurable with `member_steps` or
per-member `steps`. These are finite safety ceilings, not loop detection;
increasing them can increase latency and cost. The orchestrator also has a
bounded iteration budget based on the council size. OpenCode's repeated
identical-tool-call guard is denied automatically for both agent types, so a
stuck call fails instead of waiting for user approval. That failure is eligible
for the orchestrator's single fresh retry. Useful partial results are retained
for synthesis even if their continuation attempt also fails.

The nested delegation requires `experimental.subagent_depth` of at least `2`.
It is configured in the image; standalone installations must set it explicitly.
V2 plugins do not mutate global configuration.

## Privacy and Cost

The bounded recent conversation context is sent to the orchestrator's model
provider. Synthetic messages, reasoning, ignored text, and raw tool output are
excluded. The orchestrator uses the request and only the context it considers
relevant to create one self-contained task; that derived task is then sent to
every configured council member provider, not necessarily the complete recent
conversation.

Each member independently decides whether it needs additional project files or
web sources. Content it reads may be included in requests to that member's
provider. This independent evidence gathering is intentional: members should
not be constrained to identical source material because investigative diversity
is part of the council's value.

Starting council in an empty, untitled conversation adds one tool-free title
generation request containing the council prompt. It uses the configured title
model, or the parent model when none is configured. Existing titled
conversations do not incur this request.

One command can invoke every configured member plus the orchestrator, and a
retry can add another provider request for an affected member. Disable web
access or choose fewer members when privacy, latency, or cost is more important
than model diversity.

## Troubleshooting

- A member fails: verify that its provider is connected and its model ID is
  available.
- The defaults fail: install the PPQ plugin, connect PPQ, and restart OpenCode.
- Configuration has no effect: check the OpenCode log for a validation warning
  and restart after correcting the file.
- Responses are too slow or expensive: configure fewer members and lower the
  minimum accordingly.
- A live status line stops updating: check the OpenCode log for
  `[council-ui] Could not refresh status`. Session activity must not reset the
  status; only switching conversations clears its local display.
- A member repeatedly calls the same tool: OpenCode stops the repeated call and
  the orchestrator retries that member once in a fresh session.
- `/council-last` finds no responses: reopen the parent conversation where the
  original `/council` command ran. Runs from another conversation are not
  searched automatically.

## Test

From the repository root, run:

```sh
docker build -f opencode-council-plugin/test/Dockerfile opencode-council-plugin
```

The Docker build tests configuration, permissions, step limits, retry policy,
agent registration, local server/TUI entrypoint resolution, and plugin loading
with the official OpenCode image. A reactivity regression checks that member
activity cannot clear the display. A real-terminal smoke test uses a deterministic
loopback model and two actual member sessions to verify on-screen running and
completion counts, synthesis, the finished summary, and a second run in the same
conversation, then moves the session and checks another run in a different
location. Cross-instance tests reproduce the false “no longer running” report
and check that saved member counts and newer reports are read correctly.
The terminal test also checks that the next model request includes both the
council report and the user reply, and that the parent is named from the first
council prompt before the follow-up and keeps that title on subsequent runs.
It does not call live models or guarantee provider-side concurrency.
Regression tests also exercise ignored title signals and real local deadlines,
startup cancellation races, deletion and orphan cleanup, storage and delivery
failures, expired startup and execution leases, duplicate commands, and recovery
labels. Delayed two-instance writes cover heartbeat, completion, cleanup, and
recovery races; failed delivery retains exact synthesis for explicit retrieval.
The terminal test checks that completion removes the live status line, that
the report is not duplicated in a composer panel, and that deleting the parent
conversation makes its report inaccessible through the display RPC.
