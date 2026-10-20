FROM oven/bun:latest AS unit-tests

WORKDIR /plugin
COPY package.json ./
RUN bun install
COPY plugin/ ./plugin/
COPY test/ ./test/
RUN bun test && bunx tsc --noEmit --skipLibCheck --moduleResolution bundler --module esnext --target esnext --types bun plugin/opencode-ppq.ts test/usage-plugin.ts && touch /tests-passed

FROM oven/bun:alpine AS test-runtime

FROM ghcr.io/anomalyco/opencode:2.1.1

WORKDIR /workspace
COPY --from=unit-tests /tests-passed /tests-passed
COPY --from=test-runtime /usr/local/bin/bun /usr/local/bin/bun
COPY package.json /workspace/opencode-ppq-plugin/package.json
COPY index.ts /workspace/opencode-ppq-plugin/index.ts
COPY plugin/ /workspace/opencode-ppq-plugin/plugin/
COPY test/opencode.json /workspace/.devcontainer/opencode.json
ENV OPENCODE_CONFIG=/workspace/.devcontainer/opencode.json

RUN opencode --version | grep -E '(^|v)2\.' \
    && opencode models --print-logs > /tmp/models.txt \
    && cat /tmp/models.txt \
    && opencode plugin list > /tmp/plugins.txt \
    && cat /tmp/plugins.txt \
    && grep -q 'ppq/sign-in-required' /tmp/models.txt \
    && grep -q 'ppq' /tmp/plugins.txt \
    && opencode service stop \
    || { cat /root/.local/share/opencode/log/*; exit 1; }

# A fake key and fresh catalog fixture exercise v2 model publication without
# sending credentials or making paid model calls.
COPY test/catalog-cache.json /root/.local/share/opencode/ppq-models.cache.json
COPY test/usage-plugin.ts /test/usage-plugin/index.ts
COPY test/usage.mjs /test/usage.mjs
RUN PPQ_API_KEY=test-not-a-real-key bun /test/usage.mjs \
    || { cat /root/.local/share/opencode/log/*; exit 1; }
RUN PPQ_API_KEY=test-not-a-real-key opencode models > /tmp/connected-models.txt \
    && cat /tmp/connected-models.txt \
    && grep -q 'ppq/test/catalog-model' /tmp/connected-models.txt \
    && opencode service stop \
    || { cat /root/.local/share/opencode/log/*; exit 1; }

# A separate data directory has no saved credentials or service from prior cases.
# Only provider settings supply the fake key; the catalog stays entirely local.
COPY test/settings-only.json /test/settings-only.json
COPY test/catalog-cache.json /test/settings-only-data/opencode/ppq-models.cache.json
RUN test -z "${PPQ_API_KEY:-}" \
    && for attempt in 1 2 3 4 5; do \
         OPENCODE_CONFIG=/test/settings-only.json XDG_DATA_HOME=/test/settings-only-data opencode models > /tmp/settings-only-models.txt \
           && grep -q 'ppq/test/catalog-model' /tmp/settings-only-models.txt && break; \
         sleep 1; \
       done \
    && cat /tmp/settings-only-models.txt \
    && grep -q 'ppq/test/catalog-model' /tmp/settings-only-models.txt \
    && ! grep -q 'ppq/sign-in-required' /tmp/settings-only-models.txt \
    && OPENCODE_CONFIG=/test/settings-only.json XDG_DATA_HOME=/test/settings-only-data opencode service stop \
    || { cat /test/settings-only-data/opencode/log/*; exit 1; }
