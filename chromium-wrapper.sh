#!/bin/bash
# Wrapper invoked by gsd-browser as the Chrome executable.
#
# gsd-browser calls this script and appends its own args (--remote-debugging-port,
# --user-data-dir, stealth flags, etc.). We inject the container-safe flags first,
# then "$@" passes gsd-browser's own args through. `exec` ensures signals (SIGTERM
# on daemon stop) propagate cleanly so no orphaned Chrome process is left behind.
exec /usr/bin/chromium \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  "$@"
