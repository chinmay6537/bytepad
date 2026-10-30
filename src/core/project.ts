import { getLanguage } from './languages';

export interface SourceFile {
  name: string;
  content: string;
}

export interface TestCase {
  id: string;
  name: string;
  input: string;
  expected: string;
}

export interface Project {
  language: string;
  files: SourceFile[];
  active: string;
  entry: string;
  /** Fed to the program before anything typed in the terminal. */
  stdin: string;
  args: string;
  flags: string;
  /** Compile C and C++ on Wandbox with GCC instead of in the browser. */
  useCloud: boolean;
  compiler: string;
  tests: TestCase[];
}

export const MAX_FILES = 40;
export const MAX_FILE_BYTES = 1_000_000;

export function createProject(languageId: string): Project {
  const language = getLanguage(languageId);
  return {
    language: language.id,
    files: [{ name: language.entry, content: language.template }],
    active: language.entry,
    entry: language.entry,
    stdin: language.sampleInput ?? '',
    args: '',
    flags: language.flags ?? '',
    useCloud: false,
    compiler: '',
    tests: [],
  };
}

/** Returns an error message, or null when the name is usable. */
export function validateFileName(name: string, existing: readonly string[] = []): string | null {
  if (!name.trim()) return 'File name cannot be empty.';
  if (name.length > 120) return 'File name is too long.';
  if (name.startsWith('/') || name.includes('\\')) return 'Use a relative path with forward slashes.';
  const parts = name.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return 'That path is not allowed.';
  // Control characters would corrupt terminal output and shell-style flag parsing.
  if (/[\x00-\x1f"<>|:*?]/.test(name)) return 'That name contains unsupported characters.';
  if (existing.includes(name)) return `${name} already exists.`;
  return null;
}

export function addFile(project: Project, name: string, content = ''): Project {
  return { ...project, files: [...project.files, { name, content }], active: name };
}

export function upsertFile(project: Project, name: string, content: string): Project {
  if (project.files.some((file) => file.name === name)) {
    return { ...project, files: project.files.map((file) => (file.name === name ? { ...file, content } : file)) };
  }
  return { ...project, files: [...project.files, { name, content }] };
}

export function renameFile(project: Project, from: string, to: string): Project {
  return {
    ...project,
    files: project.files.map((file) => (file.name === from ? { ...file, name: to } : file)),
    active: project.active === from ? to : project.active,
    entry: project.entry === from ? to : project.entry,
  };
}

export function removeFile(project: Project, name: string): Project {
  if (project.files.length <= 1) return project;
  const files = project.files.filter((file) => file.name !== name);
  return {
    ...project,
    files,
    active: project.active === name ? files[0].name : project.active,
    entry: project.entry === name ? files[0].name : project.entry,
  };
}

const isString = (value: unknown): value is string => typeof value === 'string';

/**
 * Rebuilds a project from untrusted data such as a shared link or old saved state.
 * Returns null when it cannot be used. Everything kept is checked, so later code can trust it.
 */
export function sanitizeProject(raw: unknown): Project | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const data = raw as Record<string, unknown>;
  if (!isString(data.language) || getLanguage(data.language).id !== data.language) return null;
  if (!Array.isArray(data.files) || data.files.length === 0 || data.files.length > MAX_FILES) return null;

  const files: SourceFile[] = [];
  for (const file of data.files as unknown[]) {
    const { name, content } = (file ?? {}) as Record<string, unknown>;
    if (!isString(name) || !isString(content) || content.length > MAX_FILE_BYTES) return null;
    if (validateFileName(name, files.map((f) => f.name))) return null;
    files.push({ name, content });
  }

  const names = files.map((file) => file.name);
  const pick = (value: unknown) => (isString(value) && names.includes(value) ? value : names[0]);
  const tests: TestCase[] = Array.isArray(data.tests)
    ? (data.tests as unknown[]).slice(0, 100).flatMap((test, index) => {
        const { id, name, input, expected } = (test ?? {}) as Record<string, unknown>;
        if (!isString(input) || !isString(expected)) return [];
        return [{ id: isString(id) ? id : `t${index}`, name: isString(name) ? name : `Test ${index + 1}`, input, expected }];
      })
    : [];

  return {
    language: data.language,
    files,
    active: pick(data.active),
    entry: pick(data.entry),
    stdin: isString(data.stdin) ? data.stdin : '',
    args: isString(data.args) ? data.args : '',
    flags: isString(data.flags) ? data.flags : getLanguage(data.language).flags ?? '',
    useCloud: data.useCloud === true,
    compiler: isString(data.compiler) ? data.compiler : '',
    tests,
  };
}

/** Splits a flags or arguments string the way a shell would, honouring quotes. */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const match of text.matchAll(pattern)) out.push(match[1] ?? match[2] ?? match[3]);
  return out;
}
