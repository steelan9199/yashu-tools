#!/usr/bin/env bash
# fontcheck — 壳：转发给同目录 fontcheck.ps1（参数原样透传）
DIR="$(cd "$(dirname "$0")" && pwd)"
exec powershell -NoProfile -File "$DIR/fontcheck.ps1" "$@"
