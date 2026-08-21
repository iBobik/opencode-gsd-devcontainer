FROM oven/bun:latest AS unit-tests

WORKDIR /plugin
COPY package.json ./
RUN bun install
COPY plugin/ ./plugin/
COPY test/ ./test/
RUN bun test && touch /tests-passed

FROM ghcr.io/anomalyco/opencode:latest

ENV OPENCODE_CONFIG_CONTENT={} \
    OPENCODE_DISABLE_AUTOUPDATE=true \
    OPENCODE_DISABLE_DEFAULT_PLUGINS=true \
    OPENCODE_DISABLE_LSP_DOWNLOAD=true \
    OPENCODE_DISABLE_MODELS_FETCH=true

WORKDIR /workspace
COPY --from=unit-tests /tests-passed /tests-passed
COPY plugin/opencode-council.ts /root/.config/opencode/plugins/opencode-council.ts

RUN opencode debug config > /tmp/config.json \
    && grep -q 'council-orchestrator' /tmp/config.json \
    && grep -q 'council-member-claude' /tmp/config.json \
    && grep -q '"council"' /tmp/config.json
