// Keys and settings: the process environment first (Replit Secrets, a shell export), then the repository's .env.
// Only the named variable is read from the file; nothing else in it is loaded or logged.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export function readKey(name) {
  if (process.env[name]) return {key: process.env[name], from: 'environment'};
  for (const file of [path.join(REPO, '.env'), path.join(REPO, 'apps/home-teardown/.env')]) {
    try {
      const line = fs.readFileSync(file, 'utf8').split(/\r?\n/).find((l) => new RegExp(`^\\s*(export\\s+)?${name}\\s*=`).test(l));
      const v = line?.split('=').slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
      if (v) return {key: v, from: path.relative(REPO, file)};
    } catch {}
  }
  return {key: null, from: null};
}
