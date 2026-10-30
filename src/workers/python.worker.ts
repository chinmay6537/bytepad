import type { SourceFile } from '../core/project';
import { waitForDebugCommand, type StartMessage, type WorkerEvent } from '../core/protocol';
import { makeStdinSource, type StdinSource } from '../core/stdio';

const post = (event: WorkerEvent, transfer: Transferable[] = []) => self.postMessage(event, { transfer });

const RUNNER = String.raw`
import io, json, os, shutil, sys, traceback, types

_ROOT = '/home/pyodide/project'

class _Debugger:
    def __init__(self, breakpoints, bridge):
        self.breakpoints = {(b['file'], b['line']) for b in breakpoints}
        self.bridge = bridge
        self.mode = 'into'
        self.stop_depth = 0

    def rel(self, filename):
        if filename.startswith(_ROOT + '/'):
            return filename[len(_ROOT) + 1:]
        if filename.startswith('/') or filename.startswith('<'):
            return None
        return filename

    def depth(self, frame):
        count = 0
        while frame is not None:
            if self.rel(frame.f_code.co_filename) is not None:
                count += 1
            frame = frame.f_back
        return count

    def trace(self, frame, event, arg):
        file = self.rel(frame.f_code.co_filename)
        if file is None:
            return None
        if event == 'line':
            depth = self.depth(frame)
            if (
                (file, frame.f_lineno) in self.breakpoints
                or self.mode == 'into'
                or (self.mode == 'over' and depth <= self.stop_depth)
                or (self.mode == 'out' and depth < self.stop_depth)
            ):
                self.pause(frame, depth)
        return self.trace

    def variables(self, frame):
        out = []
        is_module = frame.f_code.co_name == '<module>'
        for name, value in frame.f_locals.items():
            if name.startswith('__') or isinstance(value, types.ModuleType):
                continue
            if is_module and isinstance(value, (types.FunctionType, type)):
                continue
            try:
                text = repr(value)
            except Exception as exc:
                text = f'<repr failed: {exc}>'
            if len(text) > 400:
                text = text[:400] + '...'
            out.append({'name': name, 'type': type(value).__name__, 'value': text})
        return out

    def pause(self, frame, depth):
        stack = []
        current = frame
        while current is not None:
            file = self.rel(current.f_code.co_filename)
            if file is not None:
                stack.append({
                    'name': current.f_code.co_name,
                    'file': file,
                    'line': current.f_lineno,
                    'variables': self.variables(current),
                })
            current = current.f_back
        reply = json.loads(self.bridge.pause(json.dumps(stack)))
        self.mode = reply['command']
        self.stop_depth = depth
        self.breakpoints = {(b['file'], b['line']) for b in reply['breakpoints']}

def _write_project(files):
    shutil.rmtree(_ROOT, ignore_errors=True)
    os.makedirs(_ROOT)
    for name, content in files:
        path = os.path.join(_ROOT, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8', newline='') as handle:
            handle.write(content)

def _read_project():
    found = []
    for folder, dirs, names in os.walk(_ROOT):
        dirs[:] = [d for d in dirs if d != '__pycache__']
        for name in names:
            path = os.path.join(folder, name)
            if os.path.getsize(path) > 1000000:
                continue
            try:
                with open(path, encoding='utf-8', newline='') as handle:
                    found.append([os.path.relpath(path, _ROOT), handle.read()])
            except UnicodeDecodeError:
                pass
    return found

def _run(entry, argv, files, debug_breakpoints, bridge):
    _write_project(files)
    os.chdir(_ROOT)
    before = set(sys.modules)
    sys.path.insert(0, _ROOT)
    sys.argv = [entry] + list(argv)
    # A fresh text layer per run, so input left over from a previous run cannot leak in.
    sys.stdin = io.TextIOWrapper(io.BufferedReader(io.FileIO(0, 'r', closefd=False)), encoding='utf-8')
    main = types.ModuleType('__main__')
    main.__file__ = entry
    previous_main = sys.modules.get('__main__')
    sys.modules['__main__'] = main
    code = 0
    try:
        with open(entry, encoding='utf-8') as handle:
            source = handle.read()
        compiled = compile(source, entry, 'exec')
        if debug_breakpoints is not None:
            sys.settrace(_Debugger(debug_breakpoints, bridge).trace)
        exec(compiled, main.__dict__)
    except SystemExit as exc:
        if exc.code is None:
            code = 0
        elif isinstance(exc.code, int):
            code = exc.code
        else:
            print(exc.code, file=sys.stderr)
            code = 1
    except BaseException as exc:
        sys.settrace(None)
        tb = exc.__traceback__
        # Hide this runner's own frame from the user's traceback.
        if tb is not None and tb.tb_frame.f_code.co_name == '_run':
            tb = tb.tb_next
        traceback.print_exception(type(exc), exc, tb)
        code = 1
    finally:
        sys.settrace(None)
        sys.stdout.flush()
        sys.stderr.flush()
        sys.path.remove(_ROOT)
        for name in set(sys.modules) - before:
            module = sys.modules.get(name)
            # Project modules must be re-imported next run; library modules stay loaded.
            if getattr(module, '__file__', '') and str(module.__file__).startswith(_ROOT):
                del sys.modules[name]
        if previous_main is not None:
            sys.modules['__main__'] = previous_main
        os.chdir('/')
    return [code, _read_project()]

sys.stdout.reconfigure(write_through=True)
sys.stderr.reconfigure(write_through=True)
`;

interface Pyodide {
  runPython(code: string): unknown;
  globals: { get(name: string): (...args: unknown[]) => { toJs(): [number, [string, string][]] } };
  loadPackagesFromImports(code: string, options?: { messageCallback?: (message: string) => void; errorCallback?: (message: string) => void }): Promise<unknown>;
  setStdin(options: { read(buffer: Uint8Array): number; isatty?: boolean }): void;
  setStdout(options: { write(buffer: Uint8Array): number; isatty?: boolean }): void;
  setStderr(options: { write(buffer: Uint8Array): number; isatty?: boolean }): void;
  toPy(value: unknown): unknown;
}

let pyodide: Promise<Pyodide> | undefined;
let stdin: StdinSource = { read: () => 0, blockedMs: 0 };

const boot = (vendorBase: string) => (pyodide ??= load(vendorBase));

async function load(vendorBase: string): Promise<Pyodide> {
  post({ type: 'status', text: 'Loading Python…' });
  const indexURL = `${vendorBase}pyodide/`;
  const { loadPyodide, version } = await import(/* @vite-ignore */ `${indexURL}pyodide.mjs`);
  // Only the core is self-hosted. Packages such as numpy come from the CDN on demand.
  const py: Pyodide = await loadPyodide({ indexURL, packageBaseUrl: `https://cdn.jsdelivr.net/pyodide/v${version}/full/` });
  const writer = (type: 'stdout' | 'stderr') => ({
    write(buffer: Uint8Array) {
      post({ type, data: buffer.slice() });
      return buffer.length;
    },
    isatty: true,
  });
  py.setStdin({ read: (buffer) => stdin.read(buffer), isatty: false });
  py.setStdout(writer('stdout'));
  py.setStderr(writer('stderr'));
  py.runPython(RUNNER);
  return py;
}

self.onmessage = async ({ data }: MessageEvent<StartMessage | { type: 'boot'; vendorBase: string }>) => {
  if (data.type === 'boot') {
    // Preload only. A failure here resurfaces with a useful message on the first Run.
    boot(data.vendorBase).catch(() => (pyodide = undefined));
    return;
  }
  const start = data;
  let failure: string | undefined;
  let code = 1;
  let files: SourceFile[] | undefined;
  let started = 0;
  try {
    const py = await boot(start.vendorBase);
    stdin = makeStdinSource(start.stdin);
    const source = start.files.find((file) => file.name === start.entry)?.content ?? '';
    // Packages come from the CDN, only when a program imports one that is not built in.
    await py.loadPackagesFromImports(start.files.map((file) => (file.name.endsWith('.py') ? file.content : '')).join('\n') || source, {
      messageCallback: (message) => {
        if (message.startsWith('Loading ') && !message.startsWith('Loading from')) post({ type: 'status', text: message });
      },
      errorCallback: (message) => post({ type: 'stderr', data: new TextEncoder().encode(`${message}\n`) }),
    });

    let signal = 0;
    const bridge = {
      pause(stackJson: string) {
        post({ type: 'paused', stack: JSON.parse(stackJson) });
        const waitStart = performance.now();
        const reply = waitForDebugCommand(start.debug!.control, signal);
        stdin.blockedMs += performance.now() - waitStart;
        signal = reply.signal;
        return JSON.stringify({ command: reply.command, breakpoints: reply.breakpoints });
      },
    };

    post({ type: 'status', text: 'Running' });
    started = performance.now();
    const result = py.globals.get('_run')(
      start.entry,
      py.toPy(start.args),
      py.toPy(start.files.map((file) => [file.name, file.content])),
      start.debug ? py.toPy(start.debug.breakpoints) : undefined,
      bridge,
    ).toJs();
    code = result[0];
    files = result[1].map(([name, content]) => ({ name, content }));
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  const ms = started ? performance.now() - started - stdin.blockedMs : 0;
  post({ type: 'done', code, ms, files, failure });
};
