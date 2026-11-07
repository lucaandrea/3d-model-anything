export const REVIEW_FORMAT = 'loft-review/1' as const;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_REVIEW_BYTES = 120 * 1024 * 1024;
export const MAX_IMAGES = 40;
export const AREAS = ['Whole loft', 'Entrance & office', 'Hallway & laundry', 'Guest bathroom', 'Kitchen', 'Dining area', 'Living room', 'Stairs', 'Upstairs bedroom', 'Upstairs bathroom', 'Patio'] as const;
export const CATEGORIES = ['Position', 'Size or shape', 'Material or colour', 'Missing item', 'Remove item', 'Other'] as const;
export type ImageRole = 'annotated-screenshot' | 'reference-photo';
export interface ReviewImage { id: string; name: string; type: string; size: number; role: ImageRole }
export interface ReviewNote { id: string; area: string; title: string; notes: string; category: string; object: string; measurements: string; view: string; images: ReviewImage[] }
export interface ReviewRequest { format: typeof REVIEW_FORMAT; id: string; createdAt: string; model: { id: string; revision: string }; notes: ReviewNote[] }
export interface ModelSummary { id: string; label: string; revision: string }
export interface ReviewReceipt { id: string; receivedAt: string; noteCount: number; imageCount: number; model: ModelSummary; manifestSHA256: string }
export const isUUID = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
export const isModelID = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9-]{1,100}$/.test(v);
export function imageExtension(type: string) { return ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as Record<string, string>)[type]; }
export function imagePath(image: ReviewImage) { return `images/${image.id}.${imageExtension(image.type)}`; }
export function reviewBytes(review: ReviewRequest) { return review.notes.flatMap(n => n.images).reduce((n, image) => n + image.size, 0); }
/** Only known fields survive into the package. Uploaded text is data, never executable HTML. */
export function validateReview(value: unknown): ReviewRequest {
  const record = (v: unknown): Record<string, unknown> => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('Invalid review record.'); return v as Record<string, unknown>; };
  const str = (v: unknown, max: number, required = false): string => { if (typeof v !== 'string' || v.length > max || (required && !v.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) throw Error('A review field is missing or too long.'); return v.trim(); };
  const uuid = (v: unknown): string => { if (!isUUID(v)) throw Error('Invalid review identifier.'); return v; };
  const r = record(value), model = record(r.model);
  if (r.format !== REVIEW_FORMAT || !isModelID(model.id) || typeof model.revision !== 'string' || !/^[a-f0-9]{64}$/.test(model.revision)) throw Error('Choose a current home model before sending.');
  if (!Array.isArray(r.notes) || r.notes.length < 1 || r.notes.length > 30) throw Error('Include between 1 and 30 notes.');
  const createdAt = str(r.createdAt, 40, true);
  if (!Number.isFinite(Date.parse(createdAt))) throw Error('Invalid review date.');
  const ids = new Set<string>();
  function unique(v: unknown) { const id = uuid(v); if (ids.has(id)) throw Error('Duplicate image or note identifier.'); ids.add(id); return id; }
  const notes = r.notes.map(raw => {
    const n = record(raw);
    if (!AREAS.includes(n.area as typeof AREAS[number]) || !CATEGORIES.includes(n.category as typeof CATEGORIES[number])) throw Error('Choose a room and correction type.');
    if (!Array.isArray(n.images) || n.images.length < 1 || n.images.length > 8) throw Error('Add 1–8 screenshots or reference photos to each note.');
    const view = str(n.view, 1000);
    if (view && !/^\?room=[a-z0-9-]+(?:&(?:view|camera|source|walls)=[a-zA-Z0-9.,%_-]+)*$/.test(view)) throw Error('Invalid saved model view.');
    if (view && new URLSearchParams(view.slice(1)).get('room') !== model.id) throw Error('The saved view belongs to a different model. Start this review from the model you are correcting.');
    const images = n.images.map(rawImage => {
      const i = record(rawImage), type = str(i.type, 30);
      if (!imageExtension(type) || !Number.isInteger(i.size) || Number(i.size) < 1 || Number(i.size) > MAX_IMAGE_BYTES) throw Error('Use PNG, JPEG or WebP images up to 20 MB each.');
      if (!['annotated-screenshot', 'reference-photo'].includes(String(i.role))) throw Error('Invalid image role.');
      return { id: unique(i.id), name: str(i.name, 200, true).replace(/[\\/]/g, '_'), type, size: Number(i.size), role: i.role as ImageRole };
    });
    if (!images.some(i => i.role === 'annotated-screenshot')) throw Error('Each note needs an annotated screenshot. Add real photos as extra references.');
    return { id: unique(n.id), area: String(n.area), title: str(n.title, 140, true), notes: str(n.notes, 5000), category: String(n.category), object: str(n.object, 160), measurements: str(n.measurements, 500), view, images };
  });
  const result: ReviewRequest = { format: REVIEW_FORMAT, id: uuid(r.id), createdAt, model: { id: model.id, revision: model.revision }, notes };
  if (notes.flatMap(n => n.images).length > MAX_IMAGES || reviewBytes(result) > MAX_REVIEW_BYTES) throw Error('Split this review into smaller batches: at most 40 images and 120 MB.');
  return result;
}
