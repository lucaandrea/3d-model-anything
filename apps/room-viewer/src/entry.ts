import { ROOMS } from '../../../demos/index';

function showViewerError(reason: unknown) {
  const status = document.querySelector<HTMLOutputElement>('#viewer-status');
  if (status) status.textContent = `3D view could not finish loading: ${reason instanceof Error ? reason.message : String(reason)}`;
}
window.addEventListener('error', event => showViewerError(event.error ?? event.message));
window.addEventListener('unhandledrejection', event => showViewerError(event.reason));

const requestedRoom = new URLSearchParams(location.search).get('room');
const selectedRoom = ROOMS.find(room => room.id === requestedRoom);
const reviewLink = document.querySelector<HTMLAnchorElement>('#review-link')!;
if (selectedRoom) reviewLink.href = `/review.html?room=${encodeURIComponent(selectedRoom.id)}`;
const brand = document.querySelector<HTMLAnchorElement>('.brand')!;
brand.href = import.meta.env.BASE_URL;

if (selectedRoom) {
  document.querySelector<HTMLElement>('#scan-home')!.hidden = true;
  document.querySelector<HTMLElement>('#sidebar')!.hidden = false;
  document.querySelector<HTMLElement>('#viewport')!.hidden = false;
  document.querySelector<HTMLElement>('#controls-toggle')!.hidden = false;
  document.body.classList.remove('scan-home-mode');
  document.querySelector<HTMLOutputElement>('#viewer-status')!.textContent = `Loading ${selectedRoom.label}…`;
  await import('./main');
} else {
  const status = document.querySelector<HTMLOutputElement>('#viewer-status')!;
  status.textContent = requestedRoom ? 'Room not found · No scan loaded' : 'No scan loaded';
  const choices = document.querySelector<HTMLElement>('#available-rooms')!;
  for (const room of ROOMS) {
    const link = document.createElement('a');
    link.href = `${import.meta.env.BASE_URL}?room=${encodeURIComponent(room.id)}`;
    link.textContent = room.label;
    choices.append(link);
  }
}
