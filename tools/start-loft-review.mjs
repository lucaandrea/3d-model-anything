import { fileURLToPath } from 'node:url';
import { createReviewServer } from './loft-review-server.mjs';
const repository = fileURLToPath(new URL('../',import.meta.url));
try {
  const service = await createReviewServer({repository});
  await service.listen();
  console.log('Loft review is running. Open http://localhost:5190/review.html in Safari.');
  console.log('Choose Open on iPad for the private Wi-Fi address and access code.');
  console.log('Reviews are saved under data/reviews/. Keep this Mac awake while uploading.');
} catch (error) {
  if (error.code === 'EADDRINUSE') console.error('Port 5190 is in use. If Loft review is already running, open http://localhost:5190/review.html.');
  else console.error('Could not start Loft review:',error.message);
  process.exitCode = 1;
}
