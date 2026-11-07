#!/bin/zsh
set -e
source "${0:A:h}/environment.zsh"
cd "$SCAN_REPO_ROOT"
exec npm run dev
