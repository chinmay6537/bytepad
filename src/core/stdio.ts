// Blocking stdin across threads. A program in a worker waits on a
// SharedArrayBuffer ring until the main thread writes the bytes the user typed.

const SEQ = 0;
const WRITE = 1;
const READ = 2;
const EOF = 3;
const HEADER_BYTES = 16;
const CAPACITY = 1 << 20;

export interface StdinSource {
  /** Fills `target` and returns the byte count. Returns 0 at end of input. */
  read(target: Uint8Array): number;
  /** Time spent waiting for the user, excluded from reported run time. */
  blockedMs: number;
}

export const createStdinBuffer = (): SharedArrayBuffer => new SharedArrayBuffer(HEADER_BYTES + CAPACITY);

export class StdinWriter {
  private readonly control: Int32Array;
  private readonly data: Uint8Array;
  private pending: Uint8Array[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private eofRequested = false;

  constructor(buffer: SharedArrayBuffer) {
    this.control = new Int32Array(buffer, 0, 4);
    this.data = new Uint8Array(buffer, HEADER_BYTES);
  }

  write(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this.pending.push(bytes);
    this.flush();
  }

  eof(): void {
    this.eofRequested = true;
    this.flush();
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.pending = [];
  }

  private flush(): void {
    clearTimeout(this.timer);
    const write = Atomics.load(this.control, WRITE);
    let written = 0;
    let free = CAPACITY - (write - Atomics.load(this.control, READ));
    while (this.pending.length > 0 && free > 0) {
      const chunk = this.pending[0];
      const count = Math.min(chunk.length, free);
      for (let i = 0; i < count; i++) this.data[(write + written + i) % CAPACITY] = chunk[i];
      written += count;
      free -= count;
      if (count === chunk.length) this.pending.shift();
      else this.pending[0] = chunk.subarray(count);
    }
    if (written > 0) Atomics.store(this.control, WRITE, write + written);
    if (this.eofRequested && this.pending.length === 0) Atomics.store(this.control, EOF, 1);
    Atomics.add(this.control, SEQ, 1);
    Atomics.notify(this.control, SEQ);
    if (this.pending.length > 0) this.timer = setTimeout(() => this.flush(), 15);
  }
}

export class StdinReader implements StdinSource {
  blockedMs = 0;
  private readonly control: Int32Array;
  private readonly data: Uint8Array;

  constructor(buffer: SharedArrayBuffer, private readonly beforeBlock: () => void = () => {}) {
    this.control = new Int32Array(buffer, 0, 4);
    this.data = new Uint8Array(buffer, HEADER_BYTES);
  }

  read(target: Uint8Array): number {
    for (;;) {
      const seq = Atomics.load(this.control, SEQ);
      const read = Atomics.load(this.control, READ);
      const available = Atomics.load(this.control, WRITE) - read;
      if (available > 0) {
        const count = Math.min(available, target.length);
        for (let i = 0; i < count; i++) target[i] = this.data[(read + i) % CAPACITY];
        Atomics.store(this.control, READ, read + count);
        return count;
      }
      if (Atomics.load(this.control, EOF) === 1) return 0;
      this.beforeBlock();
      const started = performance.now();
      Atomics.wait(this.control, SEQ, seq);
      this.blockedMs += performance.now() - started;
    }
  }
}

/** Fallback for browsers without cross-origin isolation: all input is known up front. */
export class BytesReader implements StdinSource {
  blockedMs = 0;
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  read(target: Uint8Array): number {
    const count = Math.min(target.length, this.bytes.length - this.offset);
    target.set(this.bytes.subarray(this.offset, this.offset + count));
    this.offset += count;
    return count;
  }
}

export function makeStdinSource(
  channel: SharedArrayBuffer | Uint8Array,
  beforeBlock?: () => void,
): StdinSource {
  return channel instanceof Uint8Array ? new BytesReader(channel) : new StdinReader(channel, beforeBlock);
}

/** Terminal-style line editing while a program runs: echo, backspace, Enter, Ctrl+C, Ctrl+D. */
export class LineEditor {
  private line = '';

  constructor(
    private readonly handlers: {
      echo(text: string): void;
      submit(text: string): void;
      eof(): void;
      interrupt(): void;
    },
  ) {}

  feed(data: string): void {
    // Normalise so a pasted CRLF block counts as one newline per line.
    for (const ch of data.replace(/\r\n/g, '\r')) {
      if (ch === '\r' || ch === '\n') {
        this.handlers.echo('\r\n');
        this.handlers.submit(`${this.line}\n`);
        this.line = '';
      } else if (ch === '\x7f' || ch === '\b') {
        const chars = [...this.line];
        if (chars.length > 0) {
          chars.pop();
          this.line = chars.join('');
          this.handlers.echo('\b \b');
        }
      } else if (ch === '\x03') {
        this.handlers.echo('^C\r\n');
        this.line = '';
        this.handlers.interrupt();
      } else if (ch === '\x04') {
        if (this.line) this.handlers.submit(this.line);
        this.line = '';
        this.handlers.eof();
      } else if (ch >= ' ' || ch === '\t') {
        this.line += ch;
        this.handlers.echo(ch);
      }
    }
  }

  reset(): void {
    this.line = '';
  }
}
