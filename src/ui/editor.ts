import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';
import { monacoLanguageForFile } from '../core/languages';
import type { Diagnostic } from '../core/diagnostics';
import type { Project } from '../core/project';
import type { Breakpoint } from '../core/protocol';

self.MonacoEnvironment = {
  getWorker: (_id, label) => (label === 'typescript' || label === 'javascript' ? new TsWorker() : new EditorWorker()),
};

// The runner's globals, so the editor does not flag them. Leaving out the DOM lib
// also stops `const name = ...` clashing with window.name.
const RUNTIME_TYPES = `
declare const console: { log(...a: any[]): void; info(...a: any[]): void; debug(...a: any[]): void; warn(...a: any[]): void; error(...a: any[]): void; table(...a: any[]): void };
declare function prompt(message?: string): string | null;
declare function require(name: string): any;
declare const process: any;
declare const module: { exports: any };
declare function setTimeout(fn: (...a: any[]) => void, ms?: number, ...rest: any[]): number;
declare function setInterval(fn: (...a: any[]) => void, ms?: number, ...rest: any[]): number;
declare function clearTimeout(id?: number): void;
declare function clearInterval(id?: number): void;
`;

const ts = monaco.typescript;
for (const defaults of [ts.typescriptDefaults, ts.javascriptDefaults]) {
  defaults.setCompilerOptions({
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    lib: ['es2023'],
    allowNonTsExtensions: true,
    allowJs: true,
    noEmit: true,
    strict: true,
  });
  defaults.addExtraLib(RUNTIME_TYPES, 'file:///bytepad-runtime.d.ts');
  defaults.setEagerModelSync(true);
}

monaco.editor.defineTheme('bytepad-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '858b96', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'f0a93b' },
    { token: 'string', foreground: '9fd08e' },
    { token: 'number', foreground: '7cc4d8' },
  ],
  colors: {
    'editor.background': '#15171b',
    'editorGutter.background': '#15171b',
    'editor.lineHighlightBackground': '#1d2026',
    'editorLineNumber.foreground': '#5c626d',
    'editorLineNumber.activeForeground': '#c9c6be',
    'editorCursor.foreground': '#f0a93b',
    'editor.selectionBackground': '#3a3f4a',
  },
});
monaco.editor.defineTheme('bytepad-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '6f6a60', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'a85c00' },
    { token: 'string', foreground: '2e7d32' },
    { token: 'number', foreground: '0f6e84' },
  ],
  colors: {
    'editor.background': '#fbfaf6',
    'editorGutter.background': '#fbfaf6',
    'editor.lineHighlightBackground': '#f3f0e7',
    'editorLineNumber.foreground': '#a8a397',
    'editorLineNumber.activeForeground': '#23211d',
    'editorCursor.foreground': '#a85c00',
  },
});

const SEVERITY = { error: monaco.MarkerSeverity.Error, warning: monaco.MarkerSeverity.Warning, note: monaco.MarkerSeverity.Info };
const MARKER_OWNER = 'bytepad';

export class CodeEditor {
  readonly editor: monaco.editor.IStandaloneCodeEditor;
  private models = new Map<string, monaco.editor.ITextModel>();
  private breakpoints = new Map<string, string[]>();
  private pausedDecorations: monaco.editor.IEditorDecorationsCollection;
  private breakpointsEnabled = false;
  private suppressChange = false;

  constructor(
    host: HTMLElement,
    theme: 'dark' | 'light',
    private readonly onChange: (file: string, content: string) => void,
    onCursor: (line: number, column: number) => void,
  ) {
    this.editor = monaco.editor.create(host, {
      theme: `bytepad-${theme}`,
      automaticLayout: true,
      fontFamily: '"JetBrains Mono Variable", ui-monospace, Menlo, Consolas, monospace',
      fontSize: 14,
      fontLigatures: true,
      lineHeight: 21,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      padding: { top: 10, bottom: 10 },
      renderLineHighlight: 'line',
      glyphMargin: true,
      tabSize: 4,
      smoothScrolling: true,
      wordBasedSuggestions: 'currentDocument',
      bracketPairColorization: { enabled: true },
    });
    this.pausedDecorations = this.editor.createDecorationsCollection();

    this.editor.onDidChangeCursorPosition(({ position }) => onCursor(position.lineNumber, position.column));
    this.editor.onMouseDown(({ target }) => {
      if (this.breakpointsEnabled && target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && target.position) {
        this.toggleBreakpoint(target.position.lineNumber);
      }
    });
  }

  setTheme(theme: 'dark' | 'light'): void {
    monaco.editor.setTheme(`bytepad-${theme}`);
  }

  private uri = (name: string) => monaco.Uri.parse(`file:///${name.split('/').map(encodeURIComponent).join('/')}`);

  /** Replaces every open model with the given project. */
  load(project: Project): void {
    this.suppressChange = true;
    this.editor.setModel(null);
    for (const model of this.models.values()) model.dispose();
    this.models.clear();
    this.breakpoints.clear();
    this.pausedDecorations.clear();
    for (const file of project.files) this.createModel(project.language, file.name, file.content);
    this.open(project.active);
    this.suppressChange = false;
  }

  private createModel(languageId: string, name: string, content: string) {
    const fallback = this.languageFallback(languageId);
    const model = monaco.editor.createModel(content, monacoLanguageForFile(name, fallback), this.uri(name));
    model.onDidChangeContent(() => {
      if (!this.suppressChange) this.onChange(name, model.getValue());
    });
    this.models.set(name, model);
    return model;
  }

  private languageFallback(languageId: string): string {
    return languageId === 'bash' ? 'shell' : 'plaintext';
  }

  addFile(languageId: string, name: string, content: string): void {
    this.createModel(languageId, name, content);
  }

  setContent(name: string, content: string): void {
    const model = this.models.get(name);
    if (!model || model.getValue() === content) return;
    this.suppressChange = true;
    model.setValue(content);
    this.suppressChange = false;
  }

  removeFile(name: string): void {
    this.models.get(name)?.dispose();
    this.models.delete(name);
    this.breakpoints.delete(name);
  }

  open(name: string): void {
    const model = this.models.get(name);
    if (model && this.editor.getModel() !== model) this.editor.setModel(model);
  }

  reveal(name: string, line: number, column = 1): void {
    this.open(name);
    this.editor.revealLineInCenter(line);
    this.editor.setPosition({ lineNumber: line, column });
    this.editor.focus();
  }

  setMarkers(diagnostics: Diagnostic[]): void {
    for (const [name, model] of this.models) {
      monaco.editor.setModelMarkers(
        model,
        MARKER_OWNER,
        diagnostics.filter((d) => d.file === name && d.line >= 1 && d.line <= model.getLineCount()).map((d) => ({
          severity: SEVERITY[d.severity],
          message: d.message,
          startLineNumber: d.line,
          startColumn: d.column,
          endLineNumber: d.line,
          endColumn: model.getLineMaxColumn(d.line),
        })),
      );
    }
  }

  setBreakpointsEnabled(enabled: boolean): void {
    this.breakpointsEnabled = enabled;
    this.editor.updateOptions({ glyphMargin: enabled });
  }

  private toggleBreakpoint(line: number): void {
    const model = this.editor.getModel();
    if (!model) return;
    const name = [...this.models].find(([, candidate]) => candidate === model)?.[0];
    if (!name) return;
    const ids = this.breakpoints.get(name) ?? [];
    const existing = ids.find((id) => model.getDecorationRange(id)?.startLineNumber === line);
    if (existing) {
      model.deltaDecorations([existing], []);
      this.breakpoints.set(name, ids.filter((id) => id !== existing));
    } else {
      const [id] = model.deltaDecorations([], [{
        range: new monaco.Range(line, 1, line, 1),
        options: { glyphMarginClassName: 'breakpoint-glyph', stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
      }]);
      this.breakpoints.set(name, [...ids, id]);
    }
  }

  /** Read from decorations, so breakpoints follow their lines as the code is edited. */
  getBreakpoints(): Breakpoint[] {
    const out: Breakpoint[] = [];
    for (const [file, ids] of this.breakpoints) {
      const model = this.models.get(file);
      if (!model) continue;
      for (const id of ids) {
        const range = model.getDecorationRange(id);
        if (range) out.push({ file, line: range.startLineNumber });
      }
    }
    return out;
  }

  showPausedLine(file: string, line: number): void {
    this.open(file);
    this.editor.revealLineInCenterIfOutsideViewport(line);
    this.pausedDecorations.set([{ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: 'paused-line', glyphMarginClassName: 'paused-glyph' } }]);
  }

  clearPausedLine(): void {
    this.pausedDecorations.clear();
  }
}
