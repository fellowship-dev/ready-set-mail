#!/bin/bash
# serve.sh <name> <port> <persist-dir> [--var K:V ...]: start a local wrangler dev in the background, log to ~/devbox-logs/<name>.log
set -u
name=$1; port=$2; persist=$3; shift 3
cd /workspace/ready-set-mail
mkdir -p ~/devbox-logs
setsid nohup npx wrangler dev ${WRANGLER_CONFIG:+-c $WRANGLER_CONFIG} --ip 127.0.0.1 --port "$port" --persist-to "$persist" "$@" > ~/devbox-logs/"$name".log 2>&1 < /dev/null &
for i in $(seq 1 120); do
  if node -e "fetch('http://127.0.0.1:$port/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"; then echo "$name up on $port"; exit 0; fi
  sleep 2
done
echo "$name did not start"; tail -20 ~/devbox-logs/"$name".log; exit 1
