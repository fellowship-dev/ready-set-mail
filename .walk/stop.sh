#!/bin/bash
# stop.sh <port>: stop the wrangler dev listening on that port (matched on its own argv, not this script's)
for p in /proc/[0-9]*; do
  pid=${p#/proc/}; [ "$pid" = "$$" ] && continue
  c=$(tr "\0" " " < $p/cmdline 2>/dev/null)
  case "$c" in *"wrangler dev"*"--port $1 "*) kill "$pid" 2>/dev/null && echo "stopped $pid";; esac
done
