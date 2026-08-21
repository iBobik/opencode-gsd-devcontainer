# Repository Instructions

## Testing

- OpenCode may execute only `docker build` commands for testing in this repository. Do not run Bun, npm, OpenCode, or any test runner directly on the host.
- Every plugin must keep its tests in `test/Dockerfile` within that plugin's directory. The Docker build must run all behavioral tests and load the plugin with the official OpenCode image.
- Run plugin tests from the repository root with exactly these commands:

  ```sh
  docker build -f opencode-ppq-plugin/test/Dockerfile opencode-ppq-plugin
  docker build -f opencode-council-plugin/test/Dockerfile opencode-council-plugin
  docker build -f opencode-gsd-models-plugin/test/Dockerfile opencode-gsd-models-plugin
  ```

- A plugin test passes only when its `docker build` completes successfully. Do not replace these builds with direct host commands, even for a single test.
