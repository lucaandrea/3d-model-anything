# Source this from zsh to use the installed project tools.
SCAN_REPO_ROOT="${${(%):-%x}:A:h:h}"
if [[ -x /opt/homebrew/opt/node@24/bin/npm ]]; then
  export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
fi
export PATH="$SCAN_REPO_ROOT/node_modules/.bin:$PATH"
if [[ -f "$SCAN_REPO_ROOT/.venv/bin/activate" ]]; then
  source "$SCAN_REPO_ROOT/.venv/bin/activate"
fi
export CAP_PYTHON="$SCAN_REPO_ROOT/.venv/bin/python"
export CAP_URL="http://localhost:5188"
