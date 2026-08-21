# opencode-gsd-devcontainer — reusable base image.
#
# Bundles: opencode + PPQ provider and council plugins (live models, pricing, and
# read-only multi-model synthesis) +
# GSD-Core (full spec-driven loop and 6-pillar UI audit) +
# agent-browser (with the dogfood skill) + Chromium + playwright + tmux.
#
# Consuming projects do `FROM opencode-gsd-devcontainer:local` and add only their
# own extras. Build locally with:
#   docker build -t opencode-gsd-devcontainer:local .

FROM mcr.microsoft.com/devcontainers/typescript-node:4-24-trixie

# --- System deps -------------------------------------------------------------
# tmux    : long-running devservers driven by agent-browser.
# chromium: shared browser for agent-browser + playwright (no 2nd download).
RUN apt-get update \
    && apt-get install -y --no-install-recommends tmux chromium sudo \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# --- Environment -------------------------------------------------------------
ENV OPENCODE_CONFIG=/home/node/.config/opencode/opencode.json \
    AGENT_BROWSER_ENGINE=chrome \
    AGENT_BROWSER_ARGS=--no-sandbox,--disable-gpu \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
    # gsd-browser drives Chromium via a wrapper script that injects container-safe
    # flags (--no-sandbox etc.). gsd-browser owns the Chrome lifecycle — no external
    # CDP process to manage or leave orphaned.
    GSD_BROWSER_BROWSER_PATH=/home/node/.gsd-browser/chromium-wrapper.sh \
    GSD_BROWSER_BROWSER_HEADLESS=true \
    # Global npm prefix used by the external_directory allow-list in opencode.json.
    NPM_CONFIG_PREFIX=/usr/local/share/npm-global \
    PATH=/usr/local/share/npm-global/bin:$PATH

# Ensure the npm-global prefix is writable by the non-root user.
RUN mkdir -p /usr/local/share/npm-global \
    && chown -R node:node /usr/local/share/npm-global /home/node

# --- Non-root from here ------------------------------------------------------
USER node

# Global CLIs (kept @latest per project decision).
RUN npm install -g opencode-ai@latest \
    playwright agent-browser skills \
    @opengsd/gsd-core@latest @opengsd/gsd-pi @opengsd/gsd-browser
RUN curl -fsSL https://github.com/tinfoilsh/tinfoil-proxy/raw/main/install.sh | sh

# --- Baked opencode config + plugins -----------------------------------------
# Copied before the gsd-core install so gsd merges into an existing config dir.
COPY --chown=node:node opencode-global.json /home/node/.config/opencode/opencode.json
COPY --chown=node:node opencode-ppq-plugin/plugin/opencode-ppq.ts /home/node/.config/opencode/plugins/
COPY --chown=node:node opencode-council-plugin/plugin/opencode-council.ts /home/node/.config/opencode/plugins/
COPY --chown=node:node opencode-gsd-models-plugin/plugin/opencode-gsd-models.ts /home/node/.config/opencode/plugins/
COPY --chown=node:node gsd-defaults.json /home/node/.gsd/defaults.json

# Chromium wrapper for gsd-browser (see GSD_BROWSER_BROWSER_PATH above).
COPY --chown=node:node chromium-wrapper.sh /home/node/.gsd-browser/chromium-wrapper.sh
RUN chmod +x /home/node/.gsd-browser/chromium-wrapper.sh

# Installation smoke checks. Authenticated workflows are covered by plugin tests,
# not image construction.
ARG BUILDPLATFORM
ARG TARGETPLATFORM

RUN opencode --version \
    && opencode models ppq \
    && agent-browser --version \
    && playwright --version \
    && gsd-browser --version \
    && gsd --version \
    && gsd-core --help > /dev/null \
    && chromium --version \
    && tmux -V \
    && command -v tinfoil-proxy \
    && if [ "$BUILDPLATFORM" = "$TARGETPLATFORM" ]; then \
         /home/node/.gsd-browser/chromium-wrapper.sh --headless --no-sandbox --disable-gpu --dump-dom about:blank | grep -q '<html>'; \
       else \
         echo "Skipping Chromium runtime test under cross-platform emulation"; \
       fi

# GSD-Core full profile.
# `--portable-hooks` makes the hooks work inside Docker.
RUN gsd-core --opencode --global --portable-hooks \
    && test "$(node -p 'const x=require(process.env.HOME + "/.gsd/defaults.json"); x.model_profile')" = "inherit" \
    && test "$(node -p 'const x=require(process.env.HOME + "/.gsd/defaults.json"); x.resolve_model_ids')" = "omit" \
    && test -f /home/node/.config/opencode/gsd-core/bin/shared/model-catalog.json

# agent-browser dogfood skill, installed globally.
RUN npx skills add vercel-labs/agent-browser --skill agent-browser dogfood --global --yes


WORKDIR /workspace
