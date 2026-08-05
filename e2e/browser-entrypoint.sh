#!/bin/sh
#
# Put a real X display under whatever command follows, then get out of the way.
#
# `xvfb-run` is the obvious way to do this and it does not work here. The container runs as the
# invoking user's numeric uid, which has no entry in `/etc/passwd`, and `xvfb-run` shells out to
# `xauth` to write a cookie for a user it cannot name. It does not fail: it starts Xvfb, hangs before
# ever spawning the command, and holds the container open. Measured on 2026-08-05, `echo` alone sat
# for three minutes that way, and a `pnpm install` under it sat for sixteen.
#
# Starting Xvfb directly avoids the cookie entirely. `-nolisten tcp` keeps the display reachable only
# through the container's own socket, which is what makes doing without the cookie fine.
set -e

Xvfb :99 -screen 0 1440x900x24 -nolisten tcp &
XVFB_PID=$!
export DISPLAY=:99

# Wait for the socket rather than sleeping a guessed interval: Chrome exits immediately if it starts
# before the display is accepting connections, and that failure reads as a browser crash.
i=0
while [ ! -e /tmp/.X11-unix/X99 ]; do
  i=$((i + 1))
  if [ "$i" -gt 100 ]; then
    echo "Xvfb did not come up within 10 seconds" >&2
    exit 1
  fi
  sleep 0.1
done

# `exec` so the command takes over this process and receives the signals docker sends, which is what
# lets a long watch be interrupted rather than orphaned. Nothing cleans up Xvfb because nothing needs
# to: it dies with the container, and a trap here would never run, having just been exec'd away.
exec "$@"
