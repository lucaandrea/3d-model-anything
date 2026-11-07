// Loft Teardown: the reconstructed home as a page you can take apart, put back together and rearrange with Claude.
// Built with the teardown skill's kit (node apps/home-teardown/tools/build.mjs); served by apps/home-teardown/server.mjs.
import {runLive} from './live.js';

runLive().catch((e) => {
  console.error(e);
  const s = document.querySelector('.loader .s');
  if (s) s.textContent = `Could not start: ${e.message}`;
});
