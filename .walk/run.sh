#!/bin/bash
# run.sh <scenario> <base> <log> [persist]: run walk.mjs with the user-space Chromium libraries and fonts
L=$HOME/chromelibs
export LD_LIBRARY_PATH=$L/usr/lib/aarch64-linux-gnu:$L/lib/aarch64-linux-gnu:$L/usr/lib
mkdir -p $L/fc-cache
cat > $L/fonts.conf <<CONF
<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>$L/usr/share/fonts</dir><cachedir>$L/fc-cache</cachedir></fontconfig>
CONF
export FONTCONFIG_FILE=$L/fonts.conf
cd /workspace/ready-set-mail/.walk
BASE=$2 LOG=$3 PERSIST=${4:-} SHOTS=$HOME/shots PROOF=${PROOF:-} node walk.mjs "$1" 2>&1 | tail -45
