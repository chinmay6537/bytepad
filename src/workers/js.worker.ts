// Runs JavaScript and TypeScript with a Node-flavoured surface: console, prompt,
// require for project files, readline, fs and process. Each run gets a new worker.
import { transform } from 'sucrase';
import type { SourceFile } from '../core/project';
import type { StartMessage, WorkerEvent } from '../core/protocol';
import { makeStdinSource, type StdinSource } from '../core/stdio';

const post = (event: WorkerEvent) => self.postMessage(event);
const encoder = new TextEncoder();
const write = (type: 'stdout' | 'stderr', text: string) => post({ type, data: encoder.encode(text) });

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super('exit');
  }
}

/** Reads stdin line by line in a blocking way, so prompt() works like a terminal. */
class LineReader {
  private buffered = new Uint8Array(0);
  private readonly decoder = new TextDecoder();
  private ended = false;

  constructor(private readonly source: StdinSource) {}

  private fill(): void {
    const chunk = new Uint8Array(4096);
    const count = this.source.read(chunk);
    if (count === 0) {
      this.ended = true;
      return;
    }
    const merged = new Uint8Array(this.buffered.length + count);
    merged.set(this.buffered);
    merged.set(chunk.subarray(0, count), this.buffered.length);
    this.buffered = merged;
  }

  readLine(): string | null {
    for (;;) {
      const newline = this.buffered.indexOf(10);
      if (newline >= 0) {
        const line = this.decoder.decode(this.buffered.subarray(0, newline));
        this.buffered = this.buffered.subarray(newline + 1);
        return line.replace(/\r$/, '');
      }
      if (this.ended) {
        if (this.buffered.length === 0) return null;
        const rest = this.decoder.decode(this.buffered);
        this.buffered = new Uint8Array(0);
        return rest;
      }
      this.fill();
    }
  }

  readAll(): string {
    while (!this.ended) this.fill();
    const text = this.decoder.decode(this.buffered);
    this.buffered = new Uint8Array(0);
    return text;
  }
}

function inspect(value: unknown, depth = 0, seen = new Set<unknown>()): string {
  if (typeof value === 'string') return depth === 0 ? value : JSON.stringify(value);
  if (typeof value === 'function') return `[Function: ${value.name || 'anonymous'}]`;
  if (typeof value !== 'object' || value === null) return String(value);
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (seen.has(value)) return '[Circular]';
  if (depth > 3) return Array.isArray(value) ? '[Array]' : '[Object]';
  seen.add(value);
  const nested = (item: unknown) => inspect(item, depth + 1, seen);
  let text: string;
  if (Array.isArray(value)) text = value.length ? `[ ${value.map(nested).join(', ')} ]` : '[]';
  else if (value instanceof Map) text = `Map(${value.size}) { ${[...value].map(([k, v]) => `${nested(k)} => ${nested(v)}`).join(', ')} }`;
  else if (value instanceof Set) text = `Set(${value.size}) { ${[...value].map(nested).join(', ')} }`;
  else if (value instanceof Date) text = value.toISOString();
  else {
    const entries = Object.entries(value).map(([k, v]) => `${k}: ${nested(v)}`);
    text = entries.length ? `{ ${entries.join(', ')} }` : '{}';
  }
  seen.delete(value);
  return text;
}

self.onmessage = async ({ data }: MessageEvent<StartMessage>) => {
  const start = data;
  const source = makeStdinSource(start.stdin);
  const reader = new LineReader(source);
  const projectFiles = new Map<string, SourceFile>(start.files.map((file) => [file.name, file]));
  const format = (args: unknown[]) => args.map((arg) => inspect(arg)).join(' ');
  const out = (...args: unknown[]) => write('stdout', `${format(args)}\n`);
  const err = (...args: unknown[]) => write('stderr', `${format(args)}\n`);
  const fakeConsole = { log: out, info: out, debug: out, warn: err, error: err, table: out };

  let exitCode = 0;
  let pendingTimers = 0;
  let settle: () => void = () => {};
  const idle = new Promise<void>((resolve) => (settle = resolve));
  let bodyFinished = false;
  let pendingWork = 0;
  const checkIdle = () => {
    if (bodyFinished && pendingTimers === 0 && pendingWork === 0) settle();
  };

  const fail = (error: unknown) => {
    if (error instanceof ExitSignal) exitCode = error.code;
    else {
      write('stderr', `${error instanceof Error ? error.stack ?? String(error) : `Uncaught ${inspect(error)}`}\n`);
      exitCode = 1;
    }
    settle();
  };
  self.addEventListener('unhandledrejection', (event) => {
    event.preventDefault();
    fail(event.reason);
  });

  const timers = new Map<number, 'timeout' | 'interval'>();
  const nativeSetTimeout = self.setTimeout.bind(self);
  const nativeSetInterval = self.setInterval.bind(self);
  const nativeClearTimeout = self.clearTimeout.bind(self);
  const nativeClearInterval = self.clearInterval.bind(self);
  const guarded = (fn: () => void) => {
    try {
      fn();
    } catch (error) {
      fail(error);
    }
  };
  const clear = (id: number) => {
    const kind = timers.get(id);
    if (!kind) return;
    timers.delete(id);
    if (kind === 'timeout') nativeClearTimeout(id);
    else nativeClearInterval(id);
    pendingTimers--;
    checkIdle();
  };
  const scope = {
    setTimeout(fn: (...a: unknown[]) => void, ms = 0, ...rest: unknown[]) {
      pendingTimers++;
      const id: number = nativeSetTimeout(() => {
        timers.delete(id);
        guarded(() => fn(...rest));
        pendingTimers--;
        checkIdle();
      }, ms);
      timers.set(id, 'timeout');
      return id;
    },
    setInterval(fn: (...a: unknown[]) => void, ms = 0, ...rest: unknown[]) {
      pendingTimers++;
      const id: number = nativeSetInterval(() => guarded(() => fn(...rest)), ms);
      timers.set(id, 'interval');
      return id;
    },
    clearTimeout: clear,
    clearInterval: clear,
  };

  const prompt = (message = '') => {
    if (message) write('stdout', String(message));
    return reader.readLine();
  };

  const process = {
    argv: ['node', start.entry, ...start.args],
    env: {},
    platform: 'browser',
    exit(code = 0) {
      throw new ExitSignal(code);
    },
    stdout: { write: (text: unknown) => (write('stdout', String(text)), true) },
    stderr: { write: (text: unknown) => (write('stderr', String(text)), true) },
    stdin: {
      setEncoding() {},
      on(event: string, handler: (chunk?: string) => void) {
        pendingWork++;
        nativeSetTimeout(() => {
          guarded(() => {
            if (event === 'data') handler(reader.readAll());
            if (event === 'end') handler();
          });
          pendingWork--;
          checkIdle();
        }, event === 'end' ? 1 : 0);
        return this;
      },
    },
    hrtime: { bigint: () => BigInt(Math.round(performance.now() * 1e6)) },
    memoryUsage: () => ({ heapUsed: 0, rss: 0 }),
  };

  const readline = {
    createInterface() {
      const lineHandlers: ((line: string) => void)[] = [];
      const closeHandlers: (() => void)[] = [];
      let closed = false;
      let pumping = false;
      const close = () => {
        if (closed) return;
        closed = true;
        closeHandlers.forEach((handler) => handler());
      };
      const pump = () => {
        if (pumping) return;
        pumping = true;
        pendingWork++;
        nativeSetTimeout(() => {
          guarded(() => {
            while (!closed) {
              const line = reader.readLine();
              if (line === null) {
                close();
                break;
              }
              lineHandlers.forEach((handler) => handler(line));
            }
          });
          pendingWork--;
          checkIdle();
        }, 0);
      };
      return {
        on(event: string, handler: (line: string) => void) {
          if (event === 'line') {
            lineHandlers.push(handler);
            pump();
          } else if (event === 'close') closeHandlers.push(handler as unknown as () => void);
          return this;
        },
        question(query: string, callback: (answer: string) => void) {
          pendingWork++;
          nativeSetTimeout(() => {
            guarded(() => callback(prompt(query) ?? ''));
            pendingWork--;
            checkIdle();
          }, 0);
        },
        close,
        async *[Symbol.asyncIterator]() {
          for (let line = reader.readLine(); line !== null; line = reader.readLine()) yield line;
        },
      };
    },
  };

  const fs = {
    readFileSync(path: string | number) {
      if (path === 0 || path === '/dev/stdin') return reader.readAll();
      const file = projectFiles.get(String(path).replace(/^\.\//, ''));
      if (!file) throw new Error(`ENOENT: no such file: ${path}`);
      return file.content;
    },
    existsSync: (path: string) => projectFiles.has(String(path).replace(/^\.\//, '')),
    writeFileSync(path: string, content: unknown) {
      const name = String(path).replace(/^\.\//, '');
      projectFiles.set(name, { name, content: String(content) });
    },
  };

  const builtins: Record<string, unknown> = { readline, fs, process };
  const modules = new Map<string, { exports: unknown }>();

  function resolveModule(from: string, spec: string): string | null {
    const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
    const parts: string[] = [];
    for (const part of `${dir}/${spec}`.split('/')) {
      if (part === '' || part === '.') continue;
      if (part === '..') parts.pop();
      else parts.push(part);
    }
    const base = parts.join('/');
    return [base, `${base}.ts`, `${base}.js`, `${base}.json`, `${base}/index.ts`, `${base}/index.js`].find((name) => projectFiles.has(name)) ?? null;
  }

  function load(name: string): unknown {
    const existing = modules.get(name);
    if (existing) return existing.exports;
    const file = projectFiles.get(name)!;
    const module = { exports: {} as unknown };
    modules.set(name, module);
    if (name.endsWith('.json')) {
      module.exports = JSON.parse(file.content);
      return module.exports;
    }
    const require = makeRequire(name);
    compileModule(name, file.content)(require, module, module.exports, fakeConsole, prompt, process, scope.setTimeout, scope.setInterval, scope.clearTimeout, scope.clearInterval);
    return module.exports;
  }

  function makeRequire(from: string) {
    return (spec: string) => {
      const bare = spec.replace(/^node:/, '');
      if (bare in builtins) return builtins[bare];
      const resolved = spec.startsWith('.') ? resolveModule(from, spec) : null;
      if (!resolved) throw new Error(`Cannot find module '${spec}'. Only project files, fs and readline are available.`);
      return load(resolved);
    };
  }

  const PARAMS = 'require,module,exports,console,prompt,process,setTimeout,setInterval,clearTimeout,clearInterval';

  function compileModule(name: string, code: string) {
    // Sucrase keeps line numbers intact, so errors point at the user's own lines.
    const { code: js } = transform(code, { transforms: name.endsWith('.ts') ? ['typescript', 'imports'] : ['imports'], filePath: name, disableESTransforms: true });
    // Everything sits on the first line of the wrapper for the same reason.
    return (0, eval)(`(function(${PARAMS}){${js}\n})\n//# sourceURL=${name}`) as (...args: unknown[]) => void;
  }

  post({ type: 'status', text: 'Running' });
  const started = performance.now();
  try {
    const name = start.entry;
    const file = projectFiles.get(name)!;
    const module = { exports: {} };
    modules.set(name, module);
    // The entry file runs in an async wrapper so top-level await works in every form.
    const { code: js } = transform(file.content, { transforms: name.endsWith('.ts') ? ['typescript', 'imports'] : ['imports'], filePath: name, disableESTransforms: true });
    const run = (0, eval)(`(async function(${PARAMS}){${js}\n})\n//# sourceURL=${name}`);
    await run(makeRequire(name), module, module.exports, fakeConsole, prompt, process, scope.setTimeout, scope.setInterval, scope.clearTimeout, scope.clearInterval);
    bodyFinished = true;
    // A macrotask gap lets promise chains schedule their timers before the idle check.
    nativeSetTimeout(checkIdle, 0);
    await idle;
  } catch (error) {
    fail(error);
  }

  // Report files the program wrote through fs.writeFileSync.
  const originals = new Map(start.files.map((file) => [file.name, file.content]));
  const files = [...projectFiles.values()].filter((file) => originals.get(file.name) !== file.content);
  post({ type: 'done', code: exitCode, ms: performance.now() - started - source.blockedMs, files });
};
