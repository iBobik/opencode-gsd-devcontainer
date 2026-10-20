# Repository Instructions

## Shell Commands

- Before using Bash, read `.devcontainer/opencode.json` and prefer its exact pre-approved commands. Use them verbatim from the repository root (`/workspace` in this devcontainer).
- Prefer Read for files and directory listings, Glob for file discovery, and Grep for content searches.
- Run pre-approved commands separately. Do not add flags, redirections, pipelines, command substitutions, or chained actions.
- For a necessary command outside the allowlist, explain immediately beforehand why it is needed, why dedicated tools or an approved command are insufficient, and its expected effects. Then call Bash directly and let its permission mechanism request approval.
- Do not use the question tool merely to request command authorization. The justification belongs in the preceding assistant message.
- Do not retry denied commands through alternate syntax or tools to evade permissions.
- Command approval does not override the Docker-only testing policy below.

## Scripted Data Analysis

- When a script is more effective than direct analysis, write its Dockerfile, scripts, and required inputs into `/workspace/.tmp-analysis/` using file-editing tools. Inspect existing scratch files before replacing them.
- Run the exact analysis Docker build command listed in `.devcontainer/opencode.json`:

  ```sh
  docker build --network=none --no-cache --progress=plain -f /workspace/.tmp-analysis/Dockerfile /workspace/.tmp-analysis
  ```

- Place only required inputs and scripts in the build context and print results to build output. Prefer a locally available, pinned base image.
- If large inputs need a shell command to stage them without passing their contents through the model, justify that command and submit it to Bash's normal permission mechanism.
- This workflow permits agent-authored code inside ordinary Docker build isolation. Fixed paths constrain the invocation, not Dockerfile contents. `--network=none` restricts ordinary `RUN` networking; image pulls and remote-source fetching are separate. Build cache, images, logs, and scratch files may persist.

## Testing

- OpenCode may execute only `docker build` commands for testing in this repository. Do not run Bun, npm, OpenCode, or any test runner directly on the host.
- Every plugin must keep its tests in `test/Dockerfile` within that plugin's directory. The Docker build must run all behavioral tests and load the plugin with the official OpenCode image.
- Run plugin tests from the repository root with exactly these commands:

  ```sh
  docker build -f opencode-ppq-plugin/test/Dockerfile opencode-ppq-plugin
  docker build -f opencode-council-plugin/test/Dockerfile opencode-council-plugin
  ```

- A plugin test passes only when its `docker build` completes successfully. Do not replace these builds with direct host commands, even for a single test.
