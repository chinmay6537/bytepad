import { getLanguage } from './core/languages';
import { runOnPiston, runOnWandbox, type CloudResult } from './core/cloud';
import { splitArgs, type Project, type SourceFile } from './core/project';
import { DEBUG_BUFFER_BYTES, sendDebugCommand, type Breakpoint, type DebugCommand, type StackFrame, type StartMessage, type WorkerEvent } from './core/protocol';
import { createStdinBuffer, StdinWriter } from './core/stdio';
import type { CompileEvent, CompileRequest } from './workers/compile.worker';
import type { ExecRequest } from './workers/exec.worker';

export interface RunHandlers {
  stdout(bytes: Uint8Array): void;
  stderr(bytes: Uint8Array): void;
  status(text: string): void;
  paused?(stack: StackFrame[]): void;
}

export interface RunOptions {
  project: Project;
  /** Keep stdin open for typing. When false, input ends after project.stdin. */
  interactive: boolean;
  debug?: { breakpoints: Breakpoint[] };
  timeoutMs?: number;
  pistonUrl?: string;
  compiler?: string;
}

export interface RunResult {
  code: number;
  ms: number;
  memory?: number;
  compileMs?: number;
  /** Compiler output, shown separately from program output. */
  diagnostics: string;
  compileFailed: boolean;
  stopped: boolean;
  timedOut: boolean;
  failure?: string;
  files?: SourceFile[];
  engine: 'browser' | 'wandbox' | 'piston';
}

export const canIsolate = () => typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated === true;

const vendorBase = () => new URL('vendor/', document.baseURI).href;

export type Engine = { kind: 'local'; local: 'python' | 'js' | 'clang' } | { kind: 'cloud'; provider: 'wandbox' | 'piston' };

export function engineFor(project: Project, pistonUrl: string): Engine {
  const language = getLanguage(project.language);
  if (language.local && !project.useCloud) return { kind: 'local', local: language.local };
  return { kind: 'cloud', provider: pistonUrl ? 'piston' : 'wandbox' };
}

export class Runner {
  private python?: Worker;
  private compiler?: Worker;
  private writer?: StdinWriter;
  private debugControl?: SharedArrayBuffer;
  private cancel?: (reason: 'stopped' | 'timeout') => void;
  private compileId = 0;

  get running(): boolean {
    return this.cancel !== undefined;
  }

  /** Loads Python ahead of the first Run. Safe to call repeatedly. */
  warmPython(): void {
    if (this.python || !canIsolate()) return;
    this.python = this.newPythonWorker();
    this.python.postMessage({ type: 'boot', vendorBase: vendorBase() });
  }

  private newPythonWorker(): Worker {
    return new Worker(new URL('./workers/python.worker.ts', import.meta.url), { type: 'module' });
  }

  write(bytes: Uint8Array): void {
    this.writer?.write(bytes);
  }

  closeInput(): void {
    this.writer?.eof();
  }

  debugCommand(command: DebugCommand, breakpoints: Breakpoint[]): void {
    if (this.debugControl) sendDebugCommand(this.debugControl, command, breakpoints);
  }

  stop(): void {
    this.cancel?.('stopped');
  }

  async run(options: RunOptions, handlers: RunHandlers): Promise<RunResult> {
    const engine = engineFor(options.project, options.pistonUrl ?? '');
    return engine.kind === 'cloud' ? this.runCloud(options, handlers, engine.provider) : this.runLocal(options, handlers, engine.local);
  }

  private async runCloud(options: RunOptions, handlers: RunHandlers, provider: 'wandbox' | 'piston'): Promise<RunResult> {
    const { project } = options;
    const language = getLanguage(project.language);
    const abort = new AbortController();
    let reason: 'stopped' | 'timeout' | undefined;
    this.cancel = (why) => {
      reason = why;
      abort.abort();
    };
    const timer = options.timeoutMs ? setTimeout(() => this.cancel?.('timeout'), options.timeoutMs) : undefined;
    const started = performance.now();
    const base: RunResult = { code: 1, ms: 0, diagnostics: '', compileFailed: false, stopped: false, timedOut: false, engine: provider };
    try {
      handlers.status(provider === 'wandbox' ? 'Running on Wandbox…' : 'Running on your Piston server…');
      let result: CloudResult;
      if (provider === 'piston') {
        result = await runOnPiston(options.pistonUrl!, project, language, abort.signal);
      } else {
        if (!options.compiler) throw new Error(`No Wandbox compiler is available for ${language.label}.`);
        result = await runOnWandbox(project, options.compiler, abort.signal);
      }
      const encoder = new TextEncoder();
      if (result.stdout) handlers.stdout(encoder.encode(result.stdout));
      if (result.stderr) handlers.stderr(encoder.encode(result.stderr));
      return {
        ...base,
        code: result.exitCode,
        ms: performance.now() - started,
        diagnostics: result.compileOutput,
        compileFailed: result.compileFailed,
        failure: result.signal ? `Terminated by signal: ${result.signal}` : undefined,
      };
    } catch (error) {
      if (reason) return { ...base, stopped: reason === 'stopped', timedOut: reason === 'timeout', ms: performance.now() - started };
      const message = error instanceof Error ? error.message : String(error);
      return { ...base, failure: `Could not reach the cloud compiler (${message}). Check your connection, or use a browser-based language while offline.` };
    } finally {
      clearTimeout(timer);
      this.cancel = undefined;
    }
  }

  private async runLocal(options: RunOptions, handlers: RunHandlers, local: 'python' | 'js' | 'clang'): Promise<RunResult> {
    const { project } = options;
    const encoder = new TextEncoder();
    const initial = encoder.encode(project.stdin);
    const live = canIsolate();
    const base: RunResult = { code: 1, ms: 0, diagnostics: '', compileFailed: false, stopped: false, timedOut: false, engine: 'browser' };

    let channel: SharedArrayBuffer | Uint8Array = initial;
    if (live) {
      channel = createStdinBuffer();
      this.writer = new StdinWriter(channel);
      this.writer.write(initial);
      if (!options.interactive) this.writer.eof();
    }

    let compiled: Uint8Array | undefined;
    let compileMs: number | undefined;
    let diagnostics = '';
    try {
      if (local === 'clang') {
        const output = await this.compile(project, handlers);
        if (output.cancelled) return { ...base, stopped: output.cancelled === 'stopped', timedOut: output.cancelled === 'timeout' };
        diagnostics = output.diagnostics;
        compileMs = output.ms;
        if (!output.wasm) return { ...base, diagnostics, compileMs, compileFailed: true };
        compiled = output.wasm;
      }

      const worker = local === 'python'
        ? (this.python ??= this.newPythonWorker())
        : local === 'js'
          ? new Worker(new URL('./workers/js.worker.ts', import.meta.url), { type: 'module' })
          : new Worker(new URL('./workers/exec.worker.ts', import.meta.url), { type: 'module' });

      const message: StartMessage | ExecRequest = compiled
        ? { wasm: compiled, files: project.files, entry: project.entry, args: splitArgs(project.args), stdin: channel }
        : this.startMessage(options, channel);

      const outcome = await this.drive(worker, message, handlers, options.timeoutMs);
      if (outcome.cancelled) {
        // Terminating is the only way to stop running code, so the worker is gone.
        worker.terminate();
        if (worker === this.python) this.python = undefined;
        return { ...base, compileMs, diagnostics, stopped: outcome.cancelled === 'stopped', timedOut: outcome.cancelled === 'timeout' };
      }
      if (worker !== this.python) worker.terminate();
      return { ...base, ...outcome.done, compileMs, diagnostics };
    } finally {
      this.writer?.dispose();
      this.writer = undefined;
      this.debugControl = undefined;
      this.cancel = undefined;
    }
  }

  private startMessage(options: RunOptions, channel: SharedArrayBuffer | Uint8Array): StartMessage {
    const { project } = options;
    let debug: StartMessage['debug'];
    if (options.debug && canIsolate()) {
      this.debugControl = new SharedArrayBuffer(DEBUG_BUFFER_BYTES);
      debug = { control: this.debugControl, breakpoints: options.debug.breakpoints };
    }
    return {
      type: 'run',
      vendorBase: vendorBase(),
      files: project.files,
      entry: project.entry,
      args: splitArgs(project.args),
      stdin: channel,
      debug,
    };
  }

  private drive(worker: Worker, message: unknown, handlers: RunHandlers, timeoutMs?: number) {
    type Done = Extract<WorkerEvent, { type: 'done' }>;
    return new Promise<{ cancelled?: 'stopped' | 'timeout'; done?: Omit<Done, 'type'> }>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (value: { cancelled?: 'stopped' | 'timeout'; done?: Omit<Done, 'type'> }) => {
        clearTimeout(timer);
        worker.onmessage = null;
        worker.onerror = null;
        resolve(value);
      };
      this.cancel = (reason) => finish({ cancelled: reason });
      worker.onmessage = ({ data }: MessageEvent<WorkerEvent>) => {
        switch (data.type) {
          case 'stdout': handlers.stdout(data.data); break;
          case 'stderr': handlers.stderr(data.data); break;
          case 'status':
            handlers.status(data.text);
            // The clock starts once the program runs, not while a runtime loads.
            if (data.text === 'Running' && timeoutMs && !timer) timer = setTimeout(() => this.cancel?.('timeout'), timeoutMs);
            break;
          case 'paused': handlers.paused?.(data.stack); break;
          case 'done': finish({ done: data }); break;
        }
      };
      worker.onerror = (event) => finish({ done: { code: 1, ms: 0, failure: event.message || 'The runtime failed to load.' } });
      worker.postMessage(message);
    });
  }

  private compile(project: Project, handlers: RunHandlers) {
    type Output = { wasm?: Uint8Array; diagnostics: string; ms: number; cancelled?: 'stopped' | 'timeout' };
    const compiler = (this.compiler ??= new Worker(new URL('./workers/compile.worker.ts', import.meta.url), { type: 'module' }));
    const id = ++this.compileId;
    return new Promise<Output>((resolve) => {
      const finish = (output: Output) => {
        compiler.onmessage = null;
        compiler.onerror = null;
        resolve(output);
      };
      this.cancel = (reason) => {
        // A compile cannot be interrupted, so the worker has to go. The next run reloads it.
        compiler.terminate();
        this.compiler = undefined;
        finish({ diagnostics: '', ms: 0, cancelled: reason });
      };
      compiler.onmessage = ({ data }: MessageEvent<CompileEvent>) => {
        if (data.id !== id) return;
        if (data.type === 'status') {
          handlers.status(data.text);
          return;
        }
        finish({ wasm: data.wasm, diagnostics: data.diagnostics, ms: data.ms });
      };
      compiler.onerror = (event) => {
        this.compiler = undefined;
        finish({ diagnostics: `Compiler failed to start: ${event.message || 'unknown error'}\n`, ms: 0 });
      };
      const request: CompileRequest = {
        id,
        vendorBase: vendorBase(),
        files: project.files,
        flags: splitArgs(project.flags),
        cplusplus: project.language === 'cpp',
      };
      compiler.postMessage(request);
    });
  }
}
