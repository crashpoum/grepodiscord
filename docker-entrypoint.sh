#!/bin/sh
# GrepoCord container entrypoint.
# Runs as root only long enough to make the data directory writable for the unprivileged `node` user
# (a fresh ./data bind mount is created root-owned by Docker, which made SQLite fail with
# "unable to open database file"), then drops privileges for the actual process.
set -eu

DB_FILE="${DB_PATH:-/app/data/grepocord.sqlite}"
DATA_DIR="$(dirname "$DB_FILE")"
CLI_DIR="$(dirname "${CLI_DB_PATH:-$DATA_DIR/cli.sqlite}")"

if [ "$(id -u)" = "0" ]; then
  for d in "$DATA_DIR" "$CLI_DIR"; do
    mkdir -p "$d"
    # Only the data dir is chowned (small), never the whole app.
    chown -R node:node "$d" || echo "entrypoint: warning: could not chown $d" >&2
  done
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi

# Already unprivileged (e.g. `docker run --user ...`): just run.
exec "$@"
