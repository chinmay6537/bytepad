import type { Language } from './languages';
import { splitArgs, type Project } from './project';

export interface CloudResult {
  exitCode: number;
  signal: string;
  stdout: string;
  stderr: string;
  compileOutput: string;
  compileFailed: boolean;
}

export interface WandboxCompiler {
  name: string;
  version: string;
  language: string;
  'display-name': string;
}

const WANDBOX = 'https://wandbox.org/api';

/** Newest compiler first, skipping head builds, which are the most likely to break. */
export function selectCompilers(all: WandboxCompiler[], language: Language): WandboxCompiler[] {
  const matches = all.filter((compiler) => compiler.language === language.wandbox);
  const rank = (compiler: WandboxCompiler) => (compiler.name === language.preferredCompiler ? 0 : /head/i.test(compiler.name) ? 2 : 1);
  return [...matches].sort((a, b) => rank(a) - rank(b));
}

const JAVA_PUBLIC_CLASS = /\.java$/;

export function buildWandboxRequest(project: Project, compiler: string): Record<string, unknown> {
  const entry = project.files.find((file) => file.name === project.entry) ?? project.files[0];
  const others = project.files.filter((file) => file !== entry);
  const compilerOptions = splitArgs(project.flags);

  let code = entry.content;
  const codes = others.map((file) => ({ file: file.name, code: file.content }));

  if (JAVA_PUBLIC_CLASS.test(entry.name)) {
    // Wandbox always builds prog.java, which rejects `public class Main`. So the
    // real file keeps its name and a small launcher class calls into it.
    const className = entry.name.replace(/^.*\//, '').replace(JAVA_PUBLIC_CLASS, '');
    codes.push({ file: entry.name, code: entry.content });
    code = `class prog { public static void main(String[] args) throws Exception { ${className}.main(args); } }\n`;
  }

  // Extra translation units are not compiled unless named on the command line.
  if (/\.(c|cc|cpp|cxx)$/.test(entry.name)) {
    for (const file of others) if (/\.(c|cc|cpp|cxx)$/.test(file.name)) compilerOptions.unshift(file.name);
  }

  return {
    compiler,
    code,
    codes,
    stdin: project.stdin,
    'compiler-option-raw': compilerOptions.join('\n'),
    'runtime-option-raw': splitArgs(project.args).join('\n'),
    save: false,
  };
}

export function parseWandboxResponse(data: Record<string, unknown>): CloudResult {
  const text = (key: string) => (typeof data[key] === 'string' ? (data[key] as string) : '');
  const status = text('status');
  const signal = text('signal');
  const compileOutput = text('compiler_message');
  const stdout = text('program_output');
  const stderr = text('program_error');
  return {
    exitCode: status === '' ? (signal ? 1 : 0) : Number(status) || 0,
    signal,
    stdout,
    stderr,
    compileOutput,
    // A failed build reports a non-zero status and produces no program streams.
    compileFailed: status !== '0' && status !== '' && !signal && !stdout && !stderr && compileOutput !== '',
  };
}

export async function runOnWandbox(project: Project, compiler: string, signal: AbortSignal): Promise<CloudResult> {
  const response = await fetch(`${WANDBOX}/compile.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildWandboxRequest(project, compiler)),
    signal,
  });
  if (!response.ok) throw new Error(`Wandbox returned HTTP ${response.status}.`);
  return parseWandboxResponse(await response.json());
}

export async function fetchWandboxCompilers(signal?: AbortSignal): Promise<WandboxCompiler[]> {
  const response = await fetch(`${WANDBOX}/list.json`, { signal });
  if (!response.ok) throw new Error(`Wandbox returned HTTP ${response.status}.`);
  return response.json();
}

export function buildPistonRequest(project: Project, language: Language): Record<string, unknown> {
  const entry = project.files.find((file) => file.name === project.entry) ?? project.files[0];
  // Piston treats the first file as the entry point.
  const files = [entry, ...project.files.filter((file) => file !== entry)].map((file) => ({
    name: file.name,
    content: file.content,
  }));
  return { language: language.piston, version: '*', files, stdin: project.stdin, args: splitArgs(project.args) };
}

export function parsePistonResponse(data: Record<string, unknown>): CloudResult {
  const stage = (value: unknown) => (value ?? {}) as { stdout?: string; stderr?: string; code?: number | null; signal?: string | null };
  const run = stage(data.run);
  const compile = stage(data.compile);
  const compileFailed = data.compile !== undefined && (compile.code ?? 0) !== 0;
  return {
    exitCode: run.code ?? (compileFailed ? compile.code ?? 1 : 0),
    signal: run.signal ?? '',
    stdout: run.stdout ?? '',
    stderr: run.stderr ?? '',
    compileOutput: compile.stderr ?? '',
    compileFailed,
  };
}

/** Runs against a Piston server the user hosts. The public Piston API closed in February 2026. */
export async function runOnPiston(baseUrl: string, project: Project, language: Language, signal: AbortSignal): Promise<CloudResult> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/v2/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildPistonRequest(project, language)),
    signal,
  });
  if (!response.ok) throw new Error(`Piston returned HTTP ${response.status}.`);
  return parsePistonResponse(await response.json());
}
