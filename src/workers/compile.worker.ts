// Runs Clang. This worker stays alive between runs because loading the compiler
// is by far the slowest step. Programs execute in exec.worker.ts, so stopping an
// infinite loop never throws the warm compiler away.
import type { SourceFile } from '../core/project';
import { BITS_STDCPP, CONIO_H, CPP_EXCEPTION_SHIM, RUNTIME_PRELUDE } from './clang-shims';

export interface CompileRequest {
  id: number;
  vendorBase: string;
  files: SourceFile[];
  flags: string[];
  cplusplus: boolean;
}

export type CompileEvent =
  | { id: number; type: 'status'; text: string }
  | { id: number; type: 'done'; wasm?: Uint8Array; diagnostics: string; ms: number; cached: boolean };

type Tree = { [name: string]: Tree | string | Uint8Array };
type RunClang = (args: string[], files: Tree, options: Record<string, unknown>) => Promise<Tree>;

const SOURCE = /\.(c|cc|cpp|cxx)$/;
const CACHE_ENTRIES = 12;
const cache = new Map<string, Uint8Array>();
let runClang: RunClang | undefined;

function buildTree(files: SourceFile[], prelude: string): Tree {
  const tree: Tree = { __bytepad: { bits: { 'stdc++.h': BITS_STDCPP }, 'conio.h': CONIO_H }, [prelude]: prelude.endsWith('.cc') ? RUNTIME_PRELUDE + CPP_EXCEPTION_SHIM : RUNTIME_PRELUDE };
  for (const file of files) {
    const parts = file.name.split('/');
    let node = tree;
    for (const part of parts.slice(0, -1)) node = (node[part] ??= {}) as Tree;
    node[parts[parts.length - 1]] = file.content;
  }
  return tree;
}

self.onmessage = async ({ data }: MessageEvent<CompileRequest>) => {
  const { id, vendorBase, files, flags, cplusplus } = data;
  const send = (event: CompileEvent, transfer: Transferable[] = []) => self.postMessage(event, { transfer });
  const started = performance.now();
  const key = JSON.stringify([files, flags, cplusplus]);
  const cached = cache.get(key);
  if (cached) {
    send({ id, type: 'done', wasm: cached.slice(), diagnostics: '', ms: 0, cached: true });
    return;
  }

  let diagnostics = '';
  const decoder = new TextDecoder();
  try {
    if (!runClang) {
      send({ id, type: 'status', text: 'Downloading the compiler (first run only)…' });
      const module = await import(/* @vite-ignore */ `${vendorBase}clang/bundle.js`);
      runClang = module.runClang as RunClang;
    }
    send({ id, type: 'status', text: 'Compiling…' });
    const prelude = cplusplus ? '__bytepad_prelude.cc' : '__bytepad_prelude.c';
    const sources = files.map((file) => file.name).filter((name) => SOURCE.test(name));
    const output = await runClang(
      [cplusplus ? 'clang++' : 'clang', ...flags, '-I__bytepad', '-fno-color-diagnostics', ...sources, prelude, '-o', 'a.out', '-lm'],
      buildTree(files, prelude),
      {
        stdout: () => {},
        stderr: (bytes: Uint8Array | null) => {
          if (bytes) diagnostics += decoder.decode(bytes, { stream: true });
        },
        fetchProgress: ({ totalLength, doneLength }: { totalLength: number; doneLength: number }) => {
          if (totalLength > 0 && doneLength < totalLength) {
            send({ id, type: 'status', text: `Downloading the compiler (first run only): ${Math.round((doneLength / totalLength) * 100)}%` });
          }
        },
      },
    );
    const wasm = output['a.out'] as Uint8Array;
    if (!diagnostics) {
      if (cache.size >= CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
      cache.set(key, wasm.slice());
    }
    send({ id, type: 'done', wasm, diagnostics, ms: performance.now() - started, cached: false }, [wasm.buffer]);
  } catch (error) {
    const exit = error as { code?: unknown; message?: string };
    // A non-zero compiler exit is an ordinary result: the diagnostics explain it.
    if (typeof exit.code !== 'number') diagnostics += `\nCompiler failed to start: ${exit.message ?? String(error)}\n`;
    send({ id, type: 'done', diagnostics, ms: performance.now() - started, cached: false });
  }
};
