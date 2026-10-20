FROM oven/bun:latest AS unit-tests

WORKDIR /plugin
COPY package.json ./
RUN bun install
COPY plugin/ ./plugin/
COPY test/ ./test/
RUN bun test && bunx tsc --noEmit --skipLibCheck --moduleResolution bundler --module esnext --target esnext --types bun plugin/opencode-council.ts && touch /tests-passed

FROM ghcr.io/anomalyco/opencode:2.1.1

WORKDIR /workspace
COPY --from=unit-tests /tests-passed /tests-passed
COPY package.json /workspace/opencode-council-plugin/package.json
COPY index.ts /workspace/opencode-council-plugin/index.ts
COPY plugin/ /workspace/opencode-council-plugin/plugin/
COPY test/opencode.json /workspace/.devcontainer/opencode.json
ENV OPENCODE_CONFIG=/workspace/.devcontainer/opencode.json
COPY test/verify.ts /workspace/zz-council-test/index.ts

RUN opencode --version | grep -E '(^|v)2\.' \
    && opencode models > /tmp/models.txt \
    && opencode plugin list > /tmp/plugins.txt \
    && cat /tmp/plugins.txt \
    && test -f /tmp/council-verified \
    && grep -q 'council' /tmp/plugins.txt \
    || { cat /root/.local/share/opencode/log/*; exit 1; }
