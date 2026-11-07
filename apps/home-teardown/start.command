#!/bin/zsh
# Double-click (or run) to start the loft teardown: builds the page if needed, starts the local server and opens it.
cd "${0:A:h}"
[[ -f teardown-out/dist/loft-teardown.html ]] || node tools/build.mjs || exit 1
( sleep 1.5; open "http://127.0.0.1:5199/" ) &
exec node server.mjs "$@"
