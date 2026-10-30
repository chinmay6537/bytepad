import { strFromU8, strToU8, unzlibSync, zlibSync } from 'fflate';
import { sanitizeProject, type Project } from './project';

// Share links keep the whole project in the URL fragment. Browsers never send
// the fragment to a server, so sharing stores nothing and cannot expire.
const PREFIX = 'p=';

/** Links longer than this get truncated by some chat apps, so the UI warns about them. */
export const LONG_LINK_CHARS = 8000;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

export function encodeProject(project: Project): string {
  return PREFIX + toBase64Url(zlibSync(strToU8(JSON.stringify(project)), { level: 9 }));
}

/** Returns null for anything that is not a valid share fragment. */
export function decodeProject(fragment: string): Project | null {
  const value = fragment.replace(/^#/, '');
  if (!value.startsWith(PREFIX)) return null;
  try {
    // Cap decompressed size so a crafted link cannot exhaust memory.
    const inflated = unzlibSync(fromBase64Url(value.slice(PREFIX.length)));
    if (inflated.length > 20_000_000) return null;
    return sanitizeProject(JSON.parse(strFromU8(inflated)));
  } catch {
    return null;
  }
}
