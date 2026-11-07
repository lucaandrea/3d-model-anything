import type { RoomModule } from '../packages/room-runtime/types';
export const ROOMS: RoomModule[] = [{id:'office-v4', label:'Wes’s office', build:async () => (await import('./office-v4')).officeV4.build()}];
// Personal imports remain outside the public asset directory and production bundle.
if (import.meta.env.DEV || import.meta.env.PRIVATE_REVIEW) {
  try { ROOMS.unshift(...await (await import('./local-captures')).localCaptures()); }
  catch (error) { console.error('Could not list local captures', error); }
}
export const roomById = (id:string|null) => ROOMS.find(r=>r.id===id) ?? ROOMS[0];
export type {BuiltRoom, RoomModule} from '../packages/room-runtime/types';
