import type { RoomModule } from '../packages/room-runtime/types';

export interface LocalCapture {
  id: string;
  label: string;
  measurements: string;
  reference: string;
  photos: string;
  /** Optional locally authored Blender/glTF reconstruction. */
  model?: string;
}

export async function localCaptures(): Promise<RoomModule[]> {
  const response = await fetch('/__local-scans/index.json');
  if (!response.ok) throw new Error(`Local scan index: HTTP ${response.status}`);
  const captures: LocalCapture[] = await response.json();
  // Open the newest authored revision by default; explicit saved links still
  // select their original model so older review notes remain reproducible.
  const date = (capture: LocalCapture) => capture.id.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '';
  captures.sort((a, b) => Number(Boolean(b.model)) - Number(Boolean(a.model))
    || date(b).localeCompare(date(a)) || a.label.localeCompare(b.label));
  return captures.map(capture => ({
    id: capture.id, label: capture.label,
    async build() {
      const { buildCapturedRoom } = await import('../packages/room-runtime/captured-room');
      return buildCapturedRoom(capture);
    },
  }));
}
