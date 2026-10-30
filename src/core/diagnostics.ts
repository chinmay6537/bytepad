export type Severity = 'error' | 'warning' | 'note';

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  severity: Severity;
  message: string;
}

const CLANG_GCC = /^(.+?):(\d+):(\d+):\s+(fatal error|error|warning|note):\s+(.*)$/;
const JAVAC = /^(.+?\.java):(\d+):\s+(error|warning):\s+(.*)$/;
const GO = /^(?:\.\/)?([^\s:]+\.go):(\d+):(\d+):\s+(.*)$/;
const RUST_HEAD = /^(error|warning)(?:\[E\d+\])?:\s+(.*)$/;
const RUST_LOC = /^\s*-->\s+(.+?):(\d+):(\d+)/;
const PY_FILE = /^\s*File "(.+?)", line (\d+)/;
const PY_MESSAGE = /^[A-Za-z_][\w.]*(?:Error|Exception|Warning|Interrupt|Exit)?(?::\s.*)?$/;
const JS_FRAME = /(?:at\s+.*?\(?|^\s*)([^\s()]+\.(?:js|ts|mjs)):(\d+):(\d+)\)?\s*$/;
const SUCRASE = /^(?:SyntaxError:\s+)?(.+?)\s+\((\d+):(\d+)\)\s*$/;

const normalize = (severity: string): Severity => (severity.includes('error') ? 'error' : severity === 'warning' ? 'warning' : 'note');

/** Maps a reported path to a project file. Compilers report absolute or renamed paths. */
function resolveFile(path: string, files: readonly string[], entry: string): string | null {
  const clean = path.replace(/^\.\//, '');
  if (files.includes(clean)) return clean;
  const base = clean.split('/').pop() ?? clean;
  // Wandbox always compiles the entry file as prog.<ext>.
  if (/^prog\.\w+$/.test(base)) return entry;
  return files.find((file) => file === base || file.endsWith(`/${base}`) || clean.endsWith(`/${file}`)) ?? null;
}

/** Turns compiler or runtime output into editor markers. Output that matches nothing yields []. */
export function parseDiagnostics(output: string, files: readonly string[], entry: string): Diagnostic[] {
  const found: Diagnostic[] = [];
  const add = (path: string, line: string, column: string | number, severity: Severity, message: string) => {
    const file = resolveFile(path, files, entry);
    if (file) found.push({ file, line: Number(line), column: Number(column) || 1, severity, message: message.trim() });
  };

  const lines = output.split(/\r?\n/);
  let pythonFrame: { path: string; line: string } | null = null;
  let jsMessage = '';
  let jsFound = false;

  lines.forEach((text, index) => {
    let match: RegExpMatchArray | null;
    if ((match = text.match(CLANG_GCC))) return add(match[1], match[2], match[3], normalize(match[4]), match[5]);
    if ((match = text.match(JAVAC))) return add(match[1], match[2], 1, normalize(match[3]), match[4]);
    if ((match = text.match(GO))) return add(match[1], match[2], match[3], 'error', match[4]);
    if ((match = text.match(RUST_HEAD))) {
      const location = lines[index + 1]?.match(RUST_LOC);
      if (location) add(location[1], location[2], location[3], normalize(match[1]), match[2]);
      return;
    }
    if ((match = text.match(PY_FILE))) {
      // Keep the innermost frame that belongs to the project.
      if (resolveFile(match[1], files, entry)) pythonFrame = { path: match[1], line: match[2] };
      return;
    }
    if (pythonFrame && !text.startsWith(' ') && PY_MESSAGE.test(text)) {
      add(pythonFrame.path, pythonFrame.line, 1, 'error', text);
      pythonFrame = null;
      return;
    }
    if ((match = text.match(JS_FRAME))) {
      if (!jsFound && resolveFile(match[1], files, entry)) {
        add(match[1], match[2], match[3], 'error', jsMessage || text);
        jsFound = true;
      }
      return;
    }
    if (/^(\w*Error|Uncaught)\b/.test(text)) {
      jsMessage = text;
      const syntax = text.match(SUCRASE);
      if (syntax) add(entry, syntax[2], Number(syntax[3]) + 1, 'error', syntax[1]);
    }
  });

  return found;
}
