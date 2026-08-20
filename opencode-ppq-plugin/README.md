# OpenCode PPQ Plugin

This plugin enables the use of the PayPerQ (PPQ) provider with OpenCode.

## Installation

1. Place `opencode-ppq.ts` to plugins directory the according to [OpenCode docs](https://opencode.ai/docs/plugins/#from-local-files):
   - `.opencode/plugins/` - Project-level plugins
   - `~/.config/opencode/plugins/` - Global plugins

2. Add provider to your `opencode.json`:
   ```json
   "provider": {
     "ppq": {
       "npm": "@ai-sdk/openai-compatible",
       "name": "PayPerQ - ppq.ai",
       "options": {
         "baseURL": "https://api.ppq.ai",
         "includeUsage": true
       }
     }
   }
   ```
   [Example opencode.json](./opencode.json)

3. Start OpenCode
4. Get PPQ API key ([Open PPQ](https://ppq.ai/invite/a586e70a) -> Add funds -> Get an API key)
5. Write `/connect` in OpenCode, select PPQ.ai, paste API key

Now you can select any chat model offered by PPQ.

## Development

Run the following command to start OpenCode with plugin and testing config:

```bash
env -i HOME="$HOME" USER="$USER" PATH="$PATH" TERM="${TERM:-xterm-256color}" SHELL="${SHELL:-/bin/bash}" \
  OPENCODE_CONFIG=/workspace/opencode-ppq-plugin/opencode.json \
  OPENCODE_CONFIG_DIR=/workspace/opencode-ppq-plugin \
  OPENCODE_DISABLE_PROJECT_CONFIG=true \
  XDG_DATA_HOME=/tmp/ppq-test/data XDG_CACHE_HOME=/tmp/ppq-test/cache \
  PPQ_API_KEY="$PPQ_API_KEY" opencode
```
