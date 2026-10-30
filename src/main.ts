import '@fontsource-variable/jetbrains-mono';
import './ui/styles.css';
import { strToU8, zipSync } from 'fflate';
import { fetchWandboxCompilers, selectCompilers, type WandboxCompiler } from './core/cloud';
import { parseDiagnostics } from './core/diagnostics';
import { getLanguage, LANGUAGES } from './core/languages';
import {
  addFile, createProject, MAX_FILE_BYTES, MAX_FILES, removeFile, renameFile, sanitizeProject, upsertFile, validateFileName,
  type Project, type SourceFile, type TestCase,
} from './core/project';
import type { DebugCommand, StackFrame } from './core/protocol';
import { decodeProject, encodeProject, LONG_LINK_CHARS } from './core/share';
import { compareOutput } from './core/testcases';
import { canIsolate, engineFor, Runner } from './runner';
import { $, askText, confirmAction, el, showHelp, toast } from './ui/dom';
import { CodeEditor } from './ui/editor';
import { ProgramTerminal } from './ui/terminal';

const STORAGE = 'bytepad:v1:';
const OUTPUT_LIMIT_BYTES = 4_000_000;
const TEST_TIMEOUT_MS = 10_000;
const CLOUD_TEST_TIMEOUT_MS = 60_000;

// Reads and writes can throw in private windows, so storage is best effort.
const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): boolean {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * Isolation headers come from the service worker, so the very first visit is
 * not isolated until the worker controls the page. That takes one reload.
 */
async function ensureIsolation(): Promise<void> {
  if (import.meta.env.DEV || !('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('sw.js');
    if (self.crossOriginIsolated) return;
    await navigator.serviceWorker.ready;
    // The guard stops a reload loop if isolation still fails, such as after a hard refresh.
    if (sessionStorage.getItem('bytepad:isolation-reload')) return;
    sessionStorage.setItem('bytepad:isolation-reload', '1');
    location.reload();
    await new Promise(() => {});
  } catch {
    // Falls back to pre-filled input, which works without isolation.
  }
}

function loadSaved(languageId: string): Project {
  const raw = store.get(STORAGE + languageId);
  if (raw) {
    try {
      const project = sanitizeProject(JSON.parse(raw));
      if (project) return project;
    } catch {
      // Corrupt save: fall through to the starter template.
    }
  }
  return createProject(languageId);
}

async function boot(): Promise<void> {
  await ensureIsolation();
  await document.fonts.load('14px "JetBrains Mono Variable"').catch(() => {});

  let theme = document.documentElement.dataset.theme === 'light' ? 'light' as const : 'dark' as const;
  let project = loadSaved(store.get(`${STORAGE}language`) ?? 'python');
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let compilers: WandboxCompiler[] | undefined;
  let debugging = false;
  let paused = false;
  let pistonUrl = store.get(`${STORAGE}piston`) ?? '';

  const runner = new Runner();
  const elements = {
    language: $<HTMLSelectElement>('language'),
    engine: $('engine'),
    run: $<HTMLButtonElement>('run'),
    debug: $<HTMLButtonElement>('debug'),
    stop: $<HTMLButtonElement>('stop'),
    status: $('status'),
    metrics: $('metrics'),
    stdin: $<HTMLTextAreaElement>('stdin'),
    args: $<HTMLInputElement>('args'),
    flags: $<HTMLInputElement>('flags'),
    useCloud: $<HTMLInputElement>('use-cloud'),
    compiler: $<HTMLSelectElement>('compiler'),
    piston: $<HTMLInputElement>('piston'),
    fileList: $('file-list'),
    testList: $('test-list'),
    testsSummary: $('tests-summary'),
  };

  function save(): void {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const saved = store.set(STORAGE + project.language, JSON.stringify(project)) && store.set(`${STORAGE}language`, project.language);
      $('saved').textContent = saved ? 'Saved in this browser' : 'Could not save: storage is full or blocked';
    }, 300);
  }

  const editor = new CodeEditor(
    $('editor'),
    theme,
    (file, content) => {
      project = upsertFile(project, file, content);
      save();
    },
    (line, column) => ($('cursor').textContent = `Ln ${line}, Col ${column}`),
  );

  const terminal = new ProgramTerminal($('terminal'), theme, {
    input: (bytes) => runner.write(bytes),
    eof: () => runner.closeInput(),
    interrupt: () => runner.stop(),
    openLocation: (file, line) => editor.reveal(file, line),
    fileNames: () => project.files.map((file) => file.name),
  });

  // ---------- panels ----------
  function showTab(name: string): void {
    for (const tab of document.querySelectorAll<HTMLElement>('[role=tab]')) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
    for (const body of document.querySelectorAll<HTMLElement>('.tab-body')) body.hidden = body.dataset.body !== name;
    if (name === 'terminal') {
      terminal.resize();
      terminal.focus();
    }
  }
  for (const tab of document.querySelectorAll<HTMLElement>('[role=tab]')) tab.addEventListener('click', () => showTab(tab.dataset.tab!));

  // ---------- file list ----------
  function renderFiles(): void {
    elements.fileList.replaceChildren(...project.files.map((file) => {
      const isEntry = file.name === project.entry;
      const row = el('li', { className: file.name === project.active ? 'file active' : 'file' });
      row.append(
        el('button', {
          className: 'file-name',
          title: isEntry ? `${file.name} (runs first)` : file.name,
          onclick: () => openFile(file.name),
        }, el('span', { className: isEntry ? 'entry-dot' : 'entry-dot off', ariaHidden: 'true' }), el('span', { textContent: file.name })),
        el('span', { className: 'file-actions' },
          el('button', { className: 'mini', title: 'Run this file first', ariaLabel: `Run ${file.name} first`, textContent: '▸', hidden: isEntry, onclick: () => setEntry(file.name) }),
          el('button', { className: 'mini', title: 'Rename', ariaLabel: `Rename ${file.name}`, textContent: '✎', onclick: () => void rename(file.name) }),
          el('button', { className: 'mini', title: 'Delete', ariaLabel: `Delete ${file.name}`, textContent: '×', hidden: project.files.length === 1, onclick: () => void remove(file.name) }),
        ),
      );
      return row;
    }));
  }

  function openFile(name: string): void {
    project = { ...project, active: name };
    editor.open(name);
    renderFiles();
    save();
  }

  function setEntry(name: string): void {
    project = { ...project, entry: name };
    renderFiles();
    save();
  }

  async function rename(from: string): Promise<void> {
    const others = project.files.map((file) => file.name).filter((name) => name !== from);
    const to = await askText(`Rename ${from}`, from, (value) => validateFileName(value, others));
    if (!to || to === from) return;
    const content = project.files.find((file) => file.name === from)!.content;
    project = renameFile(project, from, to);
    editor.removeFile(from);
    editor.addFile(project.language, to, content);
    editor.open(project.active);
    renderFiles();
    save();
  }

  async function remove(name: string): Promise<void> {
    if (!(await confirmAction(`Delete ${name}?`, 'This cannot be undone.', 'Delete'))) return;
    project = removeFile(project, name);
    editor.open(project.active);
    editor.removeFile(name);
    renderFiles();
    save();
  }

  function addNewFile(name: string, content: string): void {
    project = addFile(project, name, content);
    editor.addFile(project.language, name, content);
    editor.open(name);
    renderFiles();
    save();
  }

  $('new-file').onclick = async () => {
    if (project.files.length >= MAX_FILES) return toast(`A project can hold up to ${MAX_FILES} files.`);
    const names = project.files.map((file) => file.name);
    const ext = getLanguage(project.language).entry.split('.').pop();
    const name = await askText('New file', `helper.${ext}`, (value) => validateFileName(value, names));
    if (name) addNewFile(name, '');
  };

  async function importFiles(list: FileList | File[]): Promise<void> {
    for (const file of Array.from(list)) {
      if (project.files.length >= MAX_FILES) return toast(`A project can hold up to ${MAX_FILES} files.`);
      if (file.size > MAX_FILE_BYTES) {
        toast(`${file.name} is larger than 1 MB, so it was skipped.`);
        continue;
      }
      const existing = project.files.some((entry) => entry.name === file.name);
      const content = await file.text();
      if (existing) {
        project = upsertFile(project, file.name, content);
        editor.setContent(file.name, content);
        openFile(file.name);
      } else if (validateFileName(file.name)) toast(`${file.name} has an unsupported name, so it was skipped.`);
      else addNewFile(file.name, content);
    }
  }
  $('upload').onclick = () => $('upload-input').click();
  $<HTMLInputElement>('upload-input').onchange = (event) => {
    const input = event.target as HTMLInputElement;
    if (input.files) void importFiles(input.files).finally(() => (input.value = ''));
  };
  document.addEventListener('dragover', (event) => event.preventDefault());
  document.addEventListener('drop', (event) => {
    event.preventDefault();
    if (event.dataTransfer?.files.length) void importFiles(event.dataTransfer.files);
  });

  // ---------- language and options ----------
  elements.language.append(
    el('optgroup', { label: 'Runs in your browser' }, ...LANGUAGES.filter((l) => l.local).map((l) => el('option', { value: l.id, textContent: l.label }))),
    el('optgroup', { label: 'Runs on Wandbox (cloud)' }, ...LANGUAGES.filter((l) => !l.local).map((l) => el('option', { value: l.id, textContent: l.label }))),
  );

  function renderEngine(): void {
    const engine = engineFor(project, pistonUrl);
    const language = getLanguage(project.language);
    const local = engine.kind === 'local';
    elements.engine.textContent = local ? 'On your device' : engine.provider === 'piston' ? 'Your Piston server' : 'Cloud: Wandbox';
    elements.engine.className = local ? 'engine local' : 'engine cloud';
    elements.engine.title = local
      ? 'Runs in a WebAssembly sandbox in this browser. Your code is not uploaded.'
      : 'Your code is sent to this server when you press Run.';
    $('flags-row').hidden = !language.flags;
    $('cloud-toggle-row').hidden = !(language.local && language.wandbox);
    $('compiler-row').hidden = local || engine.kind !== 'cloud' || engine.provider !== 'wandbox';
    $('stdin-hint').textContent = local && canIsolate()
      ? 'Sent first. You can also type in the Terminal while the program runs.'
      : 'Enter all input before pressing Run.';
    elements.debug.hidden = language.id !== 'python';
    editor.setBreakpointsEnabled(language.id === 'python');
    if (!local && engine.provider === 'wandbox') void loadCompilers();
    if (language.id === 'python' && !project.useCloud) runner.warmPython();
  }

  async function loadCompilers(): Promise<void> {
    try {
      compilers ??= await fetchWandboxCompilers();
    } catch {
      elements.compiler.replaceChildren(el('option', { value: '', textContent: 'Could not load the compiler list' }));
      return;
    }
    const options = selectCompilers(compilers, getLanguage(project.language));
    elements.compiler.replaceChildren(...options.map((c) => el('option', { value: c.name, textContent: `${c['display-name']} ${c.version}` })));
    if (options.some((c) => c.name === project.compiler)) elements.compiler.value = project.compiler;
  }

  function renderProject(): void {
    elements.language.value = project.language;
    elements.stdin.value = project.stdin;
    elements.args.value = project.args;
    elements.flags.value = project.flags;
    elements.useCloud.checked = project.useCloud;
    elements.piston.value = pistonUrl;
    renderFiles();
    renderTests();
    renderEngine();
  }

  function loadProject(next: Project): void {
    project = next;
    editor.load(project);
    editor.setMarkers([]);
    renderProject();
    save();
  }

  elements.language.onchange = () => {
    if (runner.running) runner.stop();
    // Flush the outgoing project now: the debounced save would otherwise be overwritten.
    store.set(STORAGE + project.language, JSON.stringify(project));
    loadProject(loadSaved(elements.language.value));
  };
  elements.stdin.oninput = () => { project = { ...project, stdin: elements.stdin.value }; save(); };
  elements.args.oninput = () => { project = { ...project, args: elements.args.value }; save(); };
  elements.flags.oninput = () => { project = { ...project, flags: elements.flags.value }; save(); };
  elements.useCloud.onchange = () => { project = { ...project, useCloud: elements.useCloud.checked }; renderEngine(); save(); };
  elements.compiler.onchange = () => { project = { ...project, compiler: elements.compiler.value }; save(); };
  elements.piston.onchange = () => {
    pistonUrl = elements.piston.value.trim();
    store.set(`${STORAGE}piston`, pistonUrl);
    renderEngine();
  };

  // ---------- running ----------
  function setRunning(running: boolean): void {
    elements.run.disabled = running;
    elements.debug.disabled = running;
    elements.stop.disabled = !running;
    $<HTMLButtonElement>('run-tests').disabled = running;
  }

  function setPaused(value: boolean): void {
    paused = value;
    for (const id of ['dbg-continue', 'dbg-over', 'dbg-into', 'dbg-out']) $<HTMLButtonElement>(id).disabled = !value;
  }

  function renderStack(stack: StackFrame[]): void {
    $('dbg-empty').hidden = true;
    $('dbg-state').hidden = false;
    const top = stack[0];
    const rows = top.variables.map((variable) => el('tr', {},
      el('td', { className: 'var-name', textContent: variable.name }),
      el('td', { className: 'var-type', textContent: variable.type }),
      el('td', { className: 'var-value', textContent: variable.value }),
    ));
    $('dbg-vars').replaceChildren(...(rows.length ? rows : [el('tr', {}, el('td', { className: 'muted', colSpan: 3, textContent: 'No variables yet.' }))]));
    $('dbg-stack').replaceChildren(...stack.map((frame) => el('li', {},
      el('button', { className: 'link', textContent: `${frame.name === '<module>' ? 'module' : frame.name}  ${frame.file}:${frame.line}`, onclick: () => editor.reveal(frame.file, frame.line) }),
    )));
    editor.showPausedLine(top.file, top.line);
  }

  function sendDebug(command: DebugCommand): void {
    if (!paused) return;
    setPaused(false);
    editor.clearPausedLine();
    elements.status.textContent = 'Running';
    runner.debugCommand(command, editor.getBreakpoints());
  }
  $('dbg-continue').onclick = () => sendDebug('continue');
  $('dbg-over').onclick = () => sendDebug('over');
  $('dbg-into').onclick = () => sendDebug('into');
  $('dbg-out').onclick = () => sendDebug('out');

  /** Adds files the program wrote to the project. Source files are left as they are in the editor. */
  function syncProducedFiles(files: SourceFile[] | undefined): void {
    if (!files) return;
    const existing = new Map(project.files.map((file) => [file.name, file.content]));
    const changed = files.filter((file) => existing.get(file.name) !== file.content && !validateFileName(file.name));
    for (const file of changed) {
      if (existing.has(file.name)) {
        project = upsertFile(project, file.name, file.content);
        editor.setContent(file.name, file.content);
      } else if (project.files.length < MAX_FILES) {
        project = upsertFile(project, file.name, file.content);
        editor.addFile(project.language, file.name, file.content);
      }
    }
    if (changed.length > 0) {
      terminal.note(`Files written by the program: ${changed.map((file) => file.name).join(', ')}`);
      renderFiles();
      save();
    }
  }

  const formatMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);

  const INPUT_PATTERN = /\b(Scanner|scanf|cin|gets|input|readLine|read_line|ReadLine|Scanln|fgets|io\.read|readLines|getLine|readln|read -r|STDIN)\b/;

  async function run(mode: { debug: boolean }): Promise<void> {
    if (runner.running) return;
    const engine = engineFor(project, pistonUrl);
    if (mode.debug && !canIsolate()) return toast('Debugging needs a cross-origin isolated page. Reload this page and try again.');

    setRunning(true);
    debugging = mode.debug;
    terminal.clear();
    editor.setMarkers([]);
    editor.clearPausedLine();
    showTab('terminal');
    elements.metrics.textContent = '';
    elements.status.textContent = 'Starting…';

    const local = engine.kind === 'local';
    const interactive = local && canIsolate();
    terminal.setAcceptingInput(interactive);
    if (!local) {
      const provider = engine.provider === 'piston' ? pistonUrl : 'wandbox.org';
      terminal.note(`Sending your code to ${provider}.`);
      if (!project.stdin && project.files.some((file) => INPUT_PATTERN.test(file.content))) {
        terminal.note('This program may read input. Cloud runs cannot pause for typing, so add it in the Input tab.');
      }
    } else if (project.language === 'cpp' && project.files.some((file) => /\b(try|throw)\b/.test(file.content))) {
      terminal.note('Heads up: browser builds cannot catch C++ exceptions, and a throw stops the program. For exceptions, turn on "Compile on Wandbox with GCC" in the Input tab.');
    } else if (!interactive && !project.stdin && project.files.some((file) => INPUT_PATTERN.test(file.content))) {
      terminal.note('Live input is unavailable in this browser session. Add input in the Input tab, or reload the page.');
    }

    if (!local && engine.provider === 'wandbox') {
      await loadCompilers();
      if (!elements.compiler.value) {
        terminal.error('Could not load the Wandbox compiler list. Check your connection.');
        setRunning(false);
        elements.status.textContent = 'Failed';
        return;
      }
    }

    let stderrText = '';
    let total = 0;
    let truncated = false;
    const decoder = new TextDecoder();
    const guard = (bytes: Uint8Array) => {
      total += bytes.length;
      if (total > OUTPUT_LIMIT_BYTES && !truncated) {
        truncated = true;
        runner.stop();
      }
      return !truncated;
    };

    if (mode.debug) {
      $('dbg-empty').hidden = false;
      $('dbg-state').hidden = true;
    }

    const result = await runner.run(
      {
        project,
        interactive,
        debug: mode.debug ? { breakpoints: editor.getBreakpoints() } : undefined,
        pistonUrl,
        compiler: elements.compiler.value,
      },
      {
        stdout: (bytes) => { if (guard(bytes)) terminal.stdout(bytes); },
        stderr: (bytes) => {
          if (guard(bytes)) {
            stderrText += decoder.decode(bytes, { stream: true });
            terminal.stderr(bytes);
          }
        },
        status: (text) => {
          elements.status.textContent = text;
          if (text === 'Running' && interactive && !mode.debug) terminal.focus();
        },
        paused: (stack) => {
          setPaused(true);
          elements.status.textContent = `Paused at ${stack[0].file}:${stack[0].line}`;
          renderStack(stack);
          showTab('debugger');
        },
      },
    );

    terminal.setAcceptingInput(false);
    setRunning(false);
    setPaused(false);
    debugging = false;
    editor.clearPausedLine();
    await terminal.afterWrites();
    terminal.ensureNewline();

    if (result.diagnostics) terminal.diagnostics(result.diagnostics.trimEnd());
    const diagnostics = parseDiagnostics(`${result.diagnostics}\n${stderrText}`, project.files.map((file) => file.name), project.entry);
    editor.setMarkers(diagnostics);

    if (truncated) terminal.error(`Stopped: the program printed more than ${OUTPUT_LIMIT_BYTES / 1_000_000} MB of output.`);
    else if (result.stopped) terminal.note('Stopped.');
    if (result.failure) terminal.error(result.failure);

    const parts: string[] = [];
    if (result.compileFailed) {
      elements.status.textContent = 'Compile failed';
      const firstError = diagnostics.find((diagnostic) => diagnostic.severity === 'error');
      if (firstError) editor.reveal(firstError.file, firstError.line, firstError.column);
    } else if (!result.stopped) {
      elements.status.textContent = result.code === 0 ? 'Finished' : `Exited with code ${result.code}`;
      if (result.ms > 0) parts.push(formatMs(result.ms));
      if (result.memory) parts.push(`${(result.memory / 1048576).toFixed(1)} MB`);
      if (result.compileMs) parts.push(`compiled in ${formatMs(result.compileMs)}`);
      terminal.note(`\r\nExit code ${result.code}${parts.length ? ` · ${parts.join(' · ')}` : ''}`);
    } else {
      elements.status.textContent = 'Stopped';
    }
    elements.metrics.textContent = parts.join(' · ');
    syncProducedFiles(result.files);
    showTab('terminal');
  }

  elements.run.onclick = () => void run({ debug: false });
  elements.debug.onclick = () => void run({ debug: true });
  elements.stop.onclick = () => runner.stop();

  // ---------- tests ----------
  const testResults = new Map<string, HTMLElement>();

  function renderTests(): void {
    testResults.clear();
    $('tests-empty').hidden = project.tests.length > 0;
    elements.testsSummary.textContent = '';
    elements.testList.replaceChildren(...project.tests.map((test, index) => {
      const update = (patch: Partial<TestCase>) => {
        project = { ...project, tests: project.tests.map((t) => (t.id === test.id ? { ...t, ...patch } : t)) };
        save();
      };
      const result = el('div', { className: 'test-result' });
      testResults.set(test.id, result);
      const input = el('textarea', { rows: 3, spellcheck: false, value: test.input, oninput: () => update({ input: input.value }) });
      const expected = el('textarea', { rows: 3, spellcheck: false, value: test.expected, oninput: () => update({ expected: expected.value }) });
      input.setAttribute('aria-label', `Input for test ${index + 1}`);
      expected.setAttribute('aria-label', `Expected output for test ${index + 1}`);
      input.setAttribute('data-testid', 'test-input');
      expected.setAttribute('data-testid', 'test-expected');
      return el('article', { className: 'test' },
        el('header', {},
          el('strong', { textContent: `Test ${index + 1}` }),
          el('button', {
            className: 'mini', textContent: '×', title: 'Remove test', ariaLabel: `Remove test ${index + 1}`,
            onclick: () => {
              project = { ...project, tests: project.tests.filter((t) => t.id !== test.id) };
              renderTests();
              save();
            },
          }),
        ),
        el('div', { className: 'test-fields' },
          el('label', {}, 'Input', input),
          el('label', {}, 'Expected output', expected),
        ),
        result,
      );
    }));
  }

  $('add-test').onclick = () => {
    project = { ...project, tests: [...project.tests, { id: crypto.randomUUID(), name: '', input: '', expected: '' }] };
    renderTests();
    save();
  };

  $('run-tests').onclick = async () => {
    if (runner.running) return;
    if (project.tests.length === 0) return toast('Add a test first.');
    const engine = engineFor(project, pistonUrl);
    if (engine.kind === 'cloud' && engine.provider === 'wandbox') await loadCompilers();
    setRunning(true);
    terminal.setAcceptingInput(false);
    elements.metrics.textContent = '';
    let passed = 0;
    let aborted = false;
    const started = performance.now();
    for (const test of project.tests) {
      const box = testResults.get(test.id)!;
      box.className = 'test-result';
      box.textContent = 'Running…';
    }
    for (const test of project.tests) {
      const box = testResults.get(test.id)!;
      if (aborted) {
        box.textContent = 'Skipped';
        continue;
      }
      let output = '';
      let errors = '';
      const decoder = new TextDecoder();
      const errorDecoder = new TextDecoder();
      const result = await runner.run(
        {
          project: { ...project, stdin: test.input },
          interactive: false,
          timeoutMs: engine.kind === 'cloud' ? CLOUD_TEST_TIMEOUT_MS : TEST_TIMEOUT_MS,
          pistonUrl,
          compiler: elements.compiler.value,
        },
        {
          stdout: (bytes) => (output += decoder.decode(bytes, { stream: true })),
          stderr: (bytes) => (errors += errorDecoder.decode(bytes, { stream: true })),
          status: (text) => (elements.status.textContent = text),
        },
      );
      const meta = result.ms > 0 ? ` · ${formatMs(result.ms)}` : '';
      if (result.compileFailed) {
        box.className = 'test-result fail';
        box.textContent = 'Did not compile. Press Run to see the errors.';
        aborted = true;
      } else if (result.stopped) {
        box.textContent = 'Stopped';
        aborted = true;
      } else if (result.timedOut) {
        box.className = 'test-result fail';
        box.textContent = 'Timed out. The program may be waiting for more input or stuck in a loop.';
      } else if (result.failure || result.code !== 0) {
        box.className = 'test-result fail';
        box.replaceChildren(
          `Failed with exit code ${result.code}${meta}`,
          el('pre', { textContent: (result.failure ?? errors.trim()).slice(0, 2000) }),
        );
      } else {
        const comparison = compareOutput(test.expected, output);
        if (comparison.passed) {
          passed++;
          box.className = 'test-result pass';
          box.textContent = `Passed${meta}`;
        } else {
          box.className = 'test-result fail';
          box.replaceChildren(
            `Failed on line ${comparison.line}${meta}`,
            el('pre', { textContent: `expected: ${comparison.expectedLine}\nactual:   ${comparison.actualLine}` }),
          );
        }
      }
    }
    setRunning(false);
    elements.status.textContent = 'Tests finished';
    elements.testsSummary.textContent = `${passed} of ${project.tests.length} passed in ${formatMs(performance.now() - started)}`;
  };

  // ---------- share, download, reset ----------
  $('share').onclick = async () => {
    const url = `${location.origin}${location.pathname}#${encodeProject(project)}`;
    try {
      await navigator.clipboard.writeText(url);
      toast(url.length > LONG_LINK_CHARS ? 'Link copied, but it is long. Some chat apps may cut it off, so Download is safer for big projects.' : 'Link copied. Anyone with it can read this code.');
    } catch {
      await askText('Copy this link', url, () => null);
    }
  };

  $('download').onclick = () => {
    const blobOf = (): [Blob, string] => {
      if (project.files.length === 1) return [new Blob([project.files[0].content], { type: 'text/plain' }), project.files[0].name];
      const zip = zipSync(Object.fromEntries(project.files.map((file) => [file.name, strToU8(file.content)])));
      return [new Blob([zip as BlobPart], { type: 'application/zip' }), `bytepad-${project.language}.zip`];
    };
    const [blob, name] = blobOf();
    const url = URL.createObjectURL(blob);
    el('a', { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  $('reset').onclick = async () => {
    if (!(await confirmAction('Reset this project?', `Your ${getLanguage(project.language).label} files, input and tests will be replaced with the starter template.`, 'Reset'))) return;
    if (runner.running) runner.stop();
    loadProject(createProject(project.language));
  };

  // ---------- chrome ----------
  $('theme').onclick = () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    store.set('bytepad:theme', theme);
    editor.setTheme(theme);
    terminal.setTheme(theme);
  };
  $('help').onclick = showHelp;

  window.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      if (!runner.running) void run({ debug: false });
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      toast('Your work saves automatically in this browser.');
    } else if (debugging && paused) {
      const command: DebugCommand | null = event.key === 'F5' ? 'continue' : event.key === 'F10' ? 'over' : event.key === 'F11' ? (event.shiftKey ? 'out' : 'into') : null;
      if (command) {
        event.preventDefault();
        sendDebug(command);
      }
    }
  }, true);

  const resizer = $('resizer');
  const workspace = $('workspace');
  const setPanelWidth = (width: number) => {
    const clamped = Math.min(Math.max(width, 260), workspace.clientWidth - 420);
    workspace.style.setProperty('--panel-width', `${clamped}px`);
    store.set('bytepad:panel-width', String(clamped));
    terminal.resize();
  };
  const savedWidth = Number(store.get('bytepad:panel-width'));
  if (savedWidth) workspace.style.setProperty('--panel-width', `${savedWidth}px`);
  resizer.addEventListener('pointerdown', (event) => {
    resizer.setPointerCapture(event.pointerId);
    const move = (moved: PointerEvent) => setPanelWidth(workspace.getBoundingClientRect().right - moved.clientX);
    resizer.addEventListener('pointermove', move);
    resizer.addEventListener('pointerup', () => resizer.removeEventListener('pointermove', move), { once: true });
  });
  resizer.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const current = $('terminal').closest('.panel')!.clientWidth;
    setPanelWidth(current + (event.key === 'ArrowLeft' ? 24 : -24));
  });

  // ---------- start ----------
  /** Opens a share link from the URL. Returns the project, without touching saved work. */
  function readSharedLink(): Project | null {
    if (location.hash.length <= 1) return null;
    const shared = decodeProject(location.hash);
    // Drop the fragment so a reload shows the user's edits rather than re-importing.
    history.replaceState(null, '', location.pathname + location.search);
    if (!shared) {
      toast('That share link is damaged or too long to open.');
      return null;
    }
    const previous = store.get(STORAGE + shared.language);
    toast(
      'Opened a shared project. Nothing has been run.',
      previous ? {
        label: 'Restore my previous work',
        run: () => {
          const restored = sanitizeProject(JSON.parse(previous));
          if (restored) loadProject(restored);
        },
      } : undefined,
    );
    return shared;
  }

  // A link can also be opened in a tab that already has Bytepad loaded.
  window.addEventListener('hashchange', () => {
    const shared = readSharedLink();
    if (!shared) return;
    if (runner.running) runner.stop();
    store.set(STORAGE + project.language, JSON.stringify(project));
    loadProject(shared);
    terminal.clear();
  });

  project = readSharedLink() ?? project;
  editor.load(project);
  renderProject();
  setRunning(false);
  navigator.serviceWorker?.controller?.postMessage('precache');
  terminal.note(canIsolate() ? 'Press Run. Programs can ask for input right here.' : 'Press Run. Add program input in the Input tab.');
}

void boot();
