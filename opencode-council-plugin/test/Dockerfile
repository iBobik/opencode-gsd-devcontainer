FROM oven/bun:latest AS unit-tests

WORKDIR /plugin
COPY package.json ./
COPY index.ts tui.ts ./
RUN bun install
COPY plugin/ ./plugin/
COPY test/ ./test/
RUN bun test && bun --conditions=browser test/display-check.ts && bunx tsc --noEmit --skipLibCheck --moduleResolution bundler --module esnext --target esnext --types bun --jsx preserve --jsxImportSource @opentui/solid plugin/opencode-council.ts plugin/tui.tsx && touch /tests-passed

FROM oven/bun:1.4.4-alpine AS terminal-runtime

FROM ghcr.io/anomalyco/opencode:2.1.1

WORKDIR /workspace
COPY --from=terminal-runtime /usr/local/bin/bun /usr/local/bin/bun
COPY --from=unit-tests /tests-passed /tests-passed
COPY --from=unit-tests /plugin/node_modules/@xterm/headless /workspace/node_modules/@xterm/headless
COPY package.json /workspace/opencode-council-plugin/package.json
COPY index.ts /workspace/opencode-council-plugin/index.ts
COPY tui.ts /workspace/opencode-council-plugin/tui.ts
COPY plugin/ /workspace/opencode-council-plugin/plugin/
COPY test/opencode.json /workspace/opencode.json
COPY test/verify.ts /workspace/zz-council-test/index.ts
COPY test/model-fixture.ts /workspace/zz-council-test/model-fixture.ts
COPY test/ui-smoke.ts /workspace/ui-smoke.ts

RUN opencode --version | grep -E '(^|v)2\.' \
    && opencode models > /tmp/models.txt \
    && opencode plugin list > /tmp/plugins.txt \
    && cat /tmp/plugins.txt \
    && test -f /tmp/council-verified \
    && grep -q 'council' /tmp/plugins.txt \
    || { cat /root/.local/share/opencode/log/*; exit 1; }

RUN bun /workspace/ui-smoke.ts
