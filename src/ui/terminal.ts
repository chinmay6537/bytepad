import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ILink } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { LineEditor } from '../core/stdio';

const palettes = {
  dark: { background: '#101216', foreground: '#e7e4dc', cursor: '#f0a93b', selectionBackground: '#3a3f4a', red: '#ff7b72', green: '#8fd18a', yellow: '#f0a93b', brightBlack: '#858b96' },
  light: { background: '#fffdf8', foreground: '#23211d', cursor: '#a85c00', selectionBackground: '#e6dfd0', red: '#c0342c', green: '#2e7d32', yellow: '#a85c00', brightBlack: '#6f6a60' },
};

export interface TerminalHandlers {
  input(bytes: Uint8Array): void;
  eof(): void;
  interrupt(): void;
  openLocation(file: string, line: number): void;
  fileNames(): string[];
}

export class ProgramTerminal {
  private readonly term: Terminal;
  private readonly fit = new FitAddon();
  private readonly editor: LineEditor;
  private readonly encoder = new TextEncoder();
  private accepting = false;

  constructor(host: HTMLElement, theme: 'dark' | 'light', handlers: TerminalHandlers) {
    this.term = new Terminal({
      convertEol: true,
      fontFamily: '"JetBrains Mono Variable", ui-monospace, Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 20000,
      cursorBlink: true,
      theme: palettes[theme],
    });
    this.term.loadAddon(this.fit);
    this.term.open(host);

    this.editor = new LineEditor({
      echo: (text) => this.term.write(text),
      submit: (text) => handlers.input(this.encoder.encode(text)),
      eof: () => handlers.eof(),
      interrupt: () => handlers.interrupt(),
    });

    this.term.onData((data) => {
      if (this.accepting) this.editor.feed(data);
    });

    // Turns "main.c:4" and Python's 'File "main.py", line 4' into jump-to-line links.
    this.term.registerLinkProvider({
      provideLinks: (row, callback) => {
        const text = this.term.buffer.active.getLine(row - 1)?.translateToString(true) ?? '';
        const links: ILink[] = [];
        const names = handlers.fileNames().map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        if (names.length > 0) {
          const pattern = new RegExp(`(?:[^\\s"]*/)?(${names.join('|')})(?::(\\d+)|", line (\\d+))`, 'g');
          for (const match of text.matchAll(pattern)) {
            const line = Number(match[2] ?? match[3]);
            links.push({
              range: { start: { x: match.index + 1, y: row }, end: { x: match.index + match[0].length, y: row } },
              text: match[0],
              activate: () => handlers.openLocation(match[1], line),
            });
          }
        }
        callback(links);
      },
    });

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }

  resize(): void {
    // Hidden tabs measure as zero, which would collapse the terminal to one column.
    if (this.term.element?.offsetParent) this.fit.fit();
  }

  setTheme(theme: 'dark' | 'light'): void {
    this.term.options.theme = palettes[theme];
  }

  setAcceptingInput(accepting: boolean): void {
    this.accepting = accepting;
    this.editor.reset();
    this.term.options.cursorBlink = accepting;
  }

  focus(): void {
    this.term.focus();
  }

  clear(): void {
    this.term.reset();
  }

  stdout(bytes: Uint8Array): void {
    this.term.write(bytes);
  }

  stderr(bytes: Uint8Array): void {
    this.term.write('\x1b[31m');
    this.term.write(bytes);
    this.term.write('\x1b[0m');
  }

  /** Bytepad's own messages, dimmed so they read as separate from program output. */
  note(text: string): void {
    this.term.write(`\x1b[90m${text}\x1b[0m\r\n`);
  }

  error(text: string): void {
    this.term.write(`\x1b[31m${text}\x1b[0m\r\n`);
  }

  /** Compiler output with errors and warnings coloured. */
  diagnostics(text: string): void {
    for (const line of text.split('\n')) {
      if (/\b(fatal )?error\b/.test(line) && /:\s/.test(line)) this.term.write(`\x1b[31m${line}\x1b[0m\r\n`);
      else if (/\bwarning\b/.test(line) && /:\s/.test(line)) this.term.write(`\x1b[33m${line}\x1b[0m\r\n`);
      else this.term.write(`${line}\r\n`);
    }
  }

  /** Starts the next message on a clean line when a program did not end with a newline. */
  ensureNewline(): void {
    if (this.term.buffer.active.cursorX > 0) this.term.write('\r\n');
  }

  afterWrites(): Promise<void> {
    return new Promise((resolve) => this.term.write('', resolve));
  }
}
