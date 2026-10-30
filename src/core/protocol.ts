import type { SourceFile } from './project';

export interface StartMessage {
  type: 'run';
  vendorBase: string;
  files: SourceFile[];
  entry: string;
  args: string[];
  /** SharedArrayBuffer for live input, or plain bytes when isolation is unavailable. */
  stdin: SharedArrayBuffer | Uint8Array;
  debug?: { control: SharedArrayBuffer; breakpoints: Breakpoint[] };
}

export interface Breakpoint {
  file: string;
  line: number;
}

export interface StackFrame {
  name: string;
  file: string;
  line: number;
  variables: { name: string; type: string; value: string }[];
}

export type DebugCommand = 'into' | 'over' | 'out' | 'continue';

export type WorkerEvent =
  | { type: 'stdout' | 'stderr'; data: Uint8Array }
  | { type: 'status'; text: string }
  | { type: 'paused'; stack: StackFrame[] }
  | { type: 'done'; code: number; ms: number; memory?: number; files?: SourceFile[]; failure?: string };

// The debug channel is a small shared buffer: a command plus breakpoints as JSON.
const SIGNAL = 0;
const COMMAND = 1;
const LENGTH = 2;
const HEADER = 12;
export const DEBUG_BUFFER_BYTES = 1 << 16;
const COMMANDS: DebugCommand[] = ['into', 'over', 'out', 'continue'];

export function sendDebugCommand(control: SharedArrayBuffer, command: DebugCommand, breakpoints: Breakpoint[]): void {
  const ints = new Int32Array(control, 0, 3);
  const encoded = new TextEncoder().encode(JSON.stringify(breakpoints)).slice(0, DEBUG_BUFFER_BYTES - HEADER);
  new Uint8Array(control, HEADER).set(encoded);
  Atomics.store(ints, LENGTH, encoded.length);
  Atomics.store(ints, COMMAND, COMMANDS.indexOf(command));
  Atomics.add(ints, SIGNAL, 1);
  Atomics.notify(ints, SIGNAL);
}

/** Blocks the worker until the main thread sends the next debugger command. */
export function waitForDebugCommand(control: SharedArrayBuffer, lastSignal: number): { signal: number; command: DebugCommand; breakpoints: Breakpoint[] } {
  const ints = new Int32Array(control, 0, 3);
  Atomics.wait(ints, SIGNAL, lastSignal);
  const length = Atomics.load(ints, LENGTH);
  // TextDecoder rejects shared memory, so copy out first.
  const copy = new Uint8Array(control, HEADER, length).slice();
  return {
    signal: Atomics.load(ints, SIGNAL),
    command: COMMANDS[Atomics.load(ints, COMMAND)],
    breakpoints: JSON.parse(new TextDecoder().decode(copy) || '[]'),
  };
}
