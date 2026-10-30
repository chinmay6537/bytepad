// Runs one compiled program, then gets thrown away. Terminating this worker is
// how Stop works, including on an infinite loop.
import { createWasi, explainTrap, ProcessExit } from '../core/wasi';
import type { SourceFile } from '../core/project';
import type { WorkerEvent } from '../core/protocol';
import { makeStdinSource } from '../core/stdio';

export interface ExecRequest {
  wasm: Uint8Array;
  files: SourceFile[];
  entry: string;
  args: string[];
  stdin: SharedArrayBuffer | Uint8Array;
}

const post = (event: WorkerEvent) => self.postMessage(event);
const FLUSH_BYTES = 1 << 16;
const FLUSH_MS = 25;

self.onmessage = async ({ data }: MessageEvent<ExecRequest>) => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const fs = new Map<string, Uint8Array>(data.files.map((file) => [file.name, encoder.encode(file.content)]));
  const originals = new Map(fs);

  // Coalesce small writes: unbuffered stdio would otherwise post one message per printf.
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let lastFlush = 0;
  const flush = () => {
    if (pendingBytes === 0) return;
    const joined = new Uint8Array(pendingBytes);
    let offset = 0;
    for (const chunk of pending) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    pending = [];
    pendingBytes = 0;
    lastFlush = performance.now();
    post({ type: 'stdout', data: joined });
  };

  const stdin = makeStdinSource(data.stdin, flush);
  const wasi = createWasi({
    args: [data.entry.replace(/\.\w+$/, ''), ...data.args],
    stdin,
    files: fs,
    flush,
    stdout(chunk) {
      pending.push(chunk);
      pendingBytes += chunk.length;
      if (pendingBytes > FLUSH_BYTES || performance.now() - lastFlush > FLUSH_MS) flush();
    },
    stderr(chunk) {
      flush();
      post({ type: 'stderr', data: chunk });
    },
  });

  let code = 0;
  let failure: string | undefined;
  let memory: WebAssembly.Memory | undefined;
  let started = 0;
  try {
    const module = await WebAssembly.compile(data.wasm as BufferSource);
    const instance = await WebAssembly.instantiate(module, wasi.imports(module));
    memory = instance.exports.memory as WebAssembly.Memory;
    wasi.setMemory(memory);
    post({ type: 'status', text: 'Running' });
    started = performance.now();
    (instance.exports._start as () => void)();
  } catch (error) {
    if (error instanceof ProcessExit) code = error.code;
    else if (error instanceof WebAssembly.RuntimeError) {
      code = 134;
      failure = `Program crashed: ${explainTrap(error.message)}.`;
    } else {
      code = 1;
      failure = error instanceof Error ? error.message : String(error);
    }
  }
  flush();
  const ms = started ? performance.now() - started - stdin.blockedMs : 0;

  // Report files the program created or changed so they appear in the sidebar.
  const files: SourceFile[] = [];
  for (const [name, bytes] of fs) {
    if (originals.get(name) === bytes || bytes.length > 1_000_000) continue;
    try {
      files.push({ name, content: decoder.decode(bytes) });
    } catch {
      // Binary output has no useful text form.
    }
  }
  post({ type: 'done', code, ms, memory: memory?.buffer.byteLength, files, failure });
};
