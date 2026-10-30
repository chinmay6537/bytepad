import { describe, expect, it } from 'vitest';
import { buildPistonRequest, buildWandboxRequest, parsePistonResponse, parseWandboxResponse, selectCompilers } from '../src/core/cloud';
import { parseDiagnostics } from '../src/core/diagnostics';
import { getLanguage, LANGUAGES } from '../src/core/languages';
import { addFile, createProject, removeFile, renameFile, sanitizeProject, splitArgs, validateFileName } from '../src/core/project';
import { decodeProject, encodeProject } from '../src/core/share';
import { BytesReader, createStdinBuffer, LineEditor, StdinReader, StdinWriter } from '../src/core/stdio';
import { compareOutput } from '../src/core/testcases';
import { explainTrap } from '../src/core/wasi';

describe('languages', () => {
  it('gives every language a runtime, a template and a unique id', () => {
    expect(new Set(LANGUAGES.map((l) => l.id)).size).toBe(LANGUAGES.length);
    for (const language of LANGUAGES) {
      expect(language.local ?? language.wandbox, language.id).toBeTruthy();
      expect(language.template.length, language.id).toBeGreaterThan(0);
    }
  });
  it('falls back to the first language for unknown ids', () => {
    expect(getLanguage('nope').id).toBe(LANGUAGES[0].id);
  });
});

describe('project', () => {
  it('rejects unsafe file names', () => {
    for (const bad of ['', '../x.py', '/etc/passwd', 'a//b', 'a\\b', 'a:b', './x', 'bad\u0007.py']) {
      expect(validateFileName(bad), JSON.stringify(bad)).not.toBeNull();
    }
    expect(validateFileName('src/util.py')).toBeNull();
    expect(validateFileName('main.py', ['main.py'])).toMatch(/exists/);
  });

  it('keeps entry and active valid across rename and removal', () => {
    let project = addFile(createProject('python'), 'util.py', 'x = 1');
    project = renameFile(project, 'main.py', 'app.py');
    expect(project.entry).toBe('app.py');
    project = removeFile(project, 'app.py');
    expect(project.entry).toBe('util.py');
    expect(project.active).toBe('util.py');
    expect(removeFile(project, 'util.py').files).toHaveLength(1);
  });

  it('sanitizes untrusted projects', () => {
    expect(sanitizeProject(null)).toBeNull();
    expect(sanitizeProject({ language: 'cobol-9000', files: [{ name: 'a', content: '' }] })).toBeNull();
    expect(sanitizeProject({ language: 'python', files: [] })).toBeNull();
    expect(sanitizeProject({ language: 'python', files: [{ name: '../evil', content: '' }] })).toBeNull();
    expect(sanitizeProject({ language: 'python', files: [{ name: 'a.py', content: '' }, { name: 'a.py', content: '' }] })).toBeNull();
    const clean = sanitizeProject({
      language: 'python',
      files: [{ name: 'a.py', content: 'print(1)' }],
      entry: 'missing.py',
      active: 42,
      tests: [{ input: 'x', expected: 'y' }, { input: 3 }],
      extra: '<script>',
    });
    expect(clean?.entry).toBe('a.py');
    expect(clean?.active).toBe('a.py');
    expect(clean?.tests).toHaveLength(1);
    expect(clean).not.toHaveProperty('extra');
  });

  it('splits arguments with quotes', () => {
    expect(splitArgs(`-a "b c" 'd e' f`)).toEqual(['-a', 'b c', 'd e', 'f']);
    expect(splitArgs('   ')).toEqual([]);
  });
});

describe('share links', () => {
  it('round-trips a project with unicode', () => {
    const project = { ...createProject('cpp'), stdin: 'नमस्ते 🌏\n' };
    expect(decodeProject(`#${encodeProject(project)}`)).toEqual(project);
  });
  it('stays URL safe', () => {
    expect(encodeProject(createProject('python'))).toMatch(/^p=[A-Za-z0-9_-]+$/);
  });
  it('rejects damaged or foreign fragments', () => {
    expect(decodeProject('#p=@@@@')).toBeNull();
    expect(decodeProject('#p=AAAA')).toBeNull();
    expect(decodeProject('#section-2')).toBeNull();
    expect(decodeProject('')).toBeNull();
  });
});

describe('diagnostics', () => {
  it('parses Clang and GCC output, including absolute paths', () => {
    const output = `main.c:4:5: error: use of undeclared identifier 'x'\n/tmp/work/util.c:2:1: warning: unused\nmain.c:9:1: note: here`;
    expect(parseDiagnostics(output, ['main.c', 'util.c'], 'main.c')).toEqual([
      { file: 'main.c', line: 4, column: 5, severity: 'error', message: "use of undeclared identifier 'x'" },
      { file: 'util.c', line: 2, column: 1, severity: 'warning', message: 'unused' },
      { file: 'main.c', line: 9, column: 1, severity: 'note', message: 'here' },
    ]);
  });
  it('maps the Wandbox prog file to the entry', () => {
    expect(parseDiagnostics('prog.cc:3:2: error: boom', ['main.cpp'], 'main.cpp')[0].file).toBe('main.cpp');
  });
  it('parses javac, Go and Rust', () => {
    expect(parseDiagnostics('Main.java:3: error: bad', ['Main.java'], 'Main.java')[0]).toMatchObject({ line: 3, severity: 'error' });
    expect(parseDiagnostics('./prog.go:5:2: undefined: x', ['main.go'], 'main.go')[0]).toMatchObject({ file: 'main.go', line: 5, column: 2 });
    expect(parseDiagnostics('error[E0425]: cannot find\n --> prog.rs:2:5\n', ['main.rs'], 'main.rs')[0]).toMatchObject({ line: 2, column: 5, message: 'cannot find' });
  });
  it('points at the innermost project frame of a Python traceback', () => {
    const output = `Traceback (most recent call last):
  File "main.py", line 3, in <module>
    helper()
  File "/home/pyodide/project/util.py", line 7, in helper
    1 / 0
  File "/lib/python314.zip/fractions.py", line 99, in other
    pass
ZeroDivisionError: division by zero`;
    expect(parseDiagnostics(output, ['main.py', 'util.py'], 'main.py')).toEqual([
      { file: 'util.py', line: 7, column: 1, severity: 'error', message: 'ZeroDivisionError: division by zero' },
    ]);
  });
  it('parses JavaScript stacks and syntax errors', () => {
    const stack = `TypeError: x is not a function\n    at main.js:2:7\n    at helper (other.js:1:1)`;
    expect(parseDiagnostics(stack, ['main.js'], 'main.js')).toEqual([
      { file: 'main.js', line: 2, column: 7, severity: 'error', message: 'TypeError: x is not a function' },
    ]);
    expect(parseDiagnostics('SyntaxError: Unexpected token (3:5)', ['main.ts'], 'main.ts')[0]).toMatchObject({ line: 3, column: 6 });
  });
  it('ignores ordinary program output and files outside the project', () => {
    expect(parseDiagnostics('hello: world\nresult 3:4', ['main.c'], 'main.c')).toEqual([]);
    expect(parseDiagnostics('/usr/include/stdio.h:1:1: error: nope', ['main.c'], 'main.c')).toEqual([]);
  });
});

describe('test case comparison', () => {
  it('ignores trailing whitespace and CRLF', () => {
    expect(compareOutput('1 2\n3\n', '1 2  \r\n3\n\n').passed).toBe(true);
  });
  it('reports the first differing line', () => {
    expect(compareOutput('a\nb\nc', 'a\nx\nc')).toEqual({ passed: false, line: 2, expectedLine: 'b', actualLine: 'x' });
  });
  it('catches missing and extra lines', () => {
    expect(compareOutput('a\nb', 'a')).toMatchObject({ passed: false, line: 2, actualLine: '(no line)' });
    expect(compareOutput('a', 'a\nb')).toMatchObject({ passed: false, line: 2, expectedLine: '(no line)' });
  });
  it('keeps leading whitespace significant', () => {
    expect(compareOutput('  a', 'a').passed).toBe(false);
  });
});

describe('stdin channel', () => {
  const read = (reader: StdinReader, size = 64) => {
    const target = new Uint8Array(size);
    return new TextDecoder().decode(target.subarray(0, reader.read(target)));
  };
  const bytes = (text: string) => new TextEncoder().encode(text);

  it('passes bytes in order and signals EOF', () => {
    const buffer = createStdinBuffer();
    const writer = new StdinWriter(buffer);
    const reader = new StdinReader(buffer);
    writer.write(bytes('hello\n'));
    writer.write(bytes('world\n'));
    expect(read(reader, 6)).toBe('hello\n');
    expect(read(reader)).toBe('world\n');
    writer.eof();
    expect(read(reader)).toBe('');
    expect(read(reader)).toBe('');
  });

  it('delivers input larger than the ring by waiting for the reader', async () => {
    const buffer = createStdinBuffer();
    const writer = new StdinWriter(buffer);
    const reader = new StdinReader(buffer);
    const size = (1 << 20) + 5000;
    writer.write(new Uint8Array(size).fill(7));
    writer.eof();
    let total = 0;
    const target = new Uint8Array(1 << 18);
    for (;;) {
      // Yield so the writer's retry timer can run: this test shares one thread.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const available = Atomics.load(new Int32Array(buffer, 0, 4), 1) - Atomics.load(new Int32Array(buffer, 0, 4), 2);
      if (available === 0 && Atomics.load(new Int32Array(buffer, 0, 4), 3) === 1) break;
      if (available > 0) {
        const count = reader.read(target);
        expect(target.subarray(0, count).every((value) => value === 7)).toBe(true);
        total += count;
      }
    }
    expect(total).toBe(size);
    writer.dispose();
  });

  it('wraps around the ring correctly', () => {
    const buffer = createStdinBuffer();
    const writer = new StdinWriter(buffer);
    const reader = new StdinReader(buffer);
    const chunk = (1 << 20) - 10;
    writer.write(new Uint8Array(chunk).fill(1));
    expect(reader.read(new Uint8Array(chunk))).toBe(chunk);
    writer.write(bytes('across-the-end\n'));
    expect(read(reader)).toBe('across-the-end\n');
  });

  it('BytesReader serves fixed input then EOF', () => {
    const reader = new BytesReader(bytes('abc'));
    const target = new Uint8Array(2);
    expect(reader.read(target)).toBe(2);
    expect(reader.read(target)).toBe(1);
    expect(reader.read(target)).toBe(0);
  });
});

describe('line editor', () => {
  function setup() {
    const log = { echo: '', submitted: [] as string[], eof: 0, interrupt: 0 };
    const editor = new LineEditor({
      echo: (text) => (log.echo += text),
      submit: (text) => log.submitted.push(text),
      eof: () => log.eof++,
      interrupt: () => log.interrupt++,
    });
    return { log, editor };
  }
  it('echoes and submits a line on Enter', () => {
    const { log, editor } = setup();
    editor.feed('hi\r');
    expect(log.submitted).toEqual(['hi\n']);
    expect(log.echo).toBe('hi\r\n');
  });
  it('handles backspace by code point, so emoji delete whole', () => {
    const { log, editor } = setup();
    editor.feed('a🌏\x7f\x7f\x7fb\r');
    expect(log.submitted).toEqual(['b\n']);
  });
  it('treats a pasted CRLF block as separate lines', () => {
    const { log, editor } = setup();
    editor.feed('one\r\ntwo\r\n');
    expect(log.submitted).toEqual(['one\n', 'two\n']);
  });
  it('Ctrl+D sends the partial line, then EOF', () => {
    const { log, editor } = setup();
    editor.feed('part\x04');
    expect(log.submitted).toEqual(['part']);
    expect(log.eof).toBe(1);
  });
  it('Ctrl+C interrupts and discards the line', () => {
    const { log, editor } = setup();
    editor.feed('oops\x03');
    expect(log.interrupt).toBe(1);
    expect(log.submitted).toEqual([]);
  });
  it('ignores escape sequences such as arrow keys', () => {
    const { log, editor } = setup();
    editor.feed('\x1b');
    editor.feed('x\r');
    expect(log.submitted).toEqual(['x\n']);
  });
});

describe('cloud requests', () => {
  it('sends the entry as code and others as codes', () => {
    const project = addFile({ ...createProject('cpp'), stdin: '5\n', args: 'a "b c"', flags: '-std=c++20 -O2' }, 'util.cpp', 'int f();');
    const request = buildWandboxRequest(project, 'gcc-13.2.0');
    expect(request.code).toContain('#include <iostream>');
    expect(request.codes).toEqual([{ file: 'util.cpp', code: 'int f();' }]);
    expect(request['compiler-option-raw']).toBe('util.cpp\n-std=c++20\n-O2');
    expect(request['runtime-option-raw']).toBe('a\nb c');
    expect(request.stdin).toBe('5\n');
    expect(request.save).toBe(false);
  });
  it('wraps Java so a public class keeps its own file name', () => {
    const request = buildWandboxRequest(createProject('java'), 'openjdk-jdk-22+36');
    expect(request.code).toContain('Main.main(args)');
    expect(request.codes).toEqual([{ file: 'Main.java', code: getLanguage('java').template }]);
  });
  it('recognises build failures and program failures', () => {
    expect(parseWandboxResponse({ status: '1', compiler_message: 'bad', program_output: '', program_error: '' })).toMatchObject({ compileFailed: true, exitCode: 1 });
    expect(parseWandboxResponse({ status: '3', compiler_message: 'warn', program_output: 'x', program_error: '' })).toMatchObject({ compileFailed: false, exitCode: 3, stdout: 'x' });
    expect(parseWandboxResponse({ status: '0', program_output: 'ok' })).toMatchObject({ exitCode: 0, compileFailed: false });
    expect(parseWandboxResponse({ signal: 'Killed', program_error: '' })).toMatchObject({ exitCode: 1, signal: 'Killed' });
  });
  it('puts stable compilers ahead of head builds', () => {
    const list = [
      { name: 'gcc-head', version: 'x', language: 'C++', 'display-name': 'gcc' },
      { name: 'gcc-13', version: '13', language: 'C++', 'display-name': 'gcc' },
      { name: 'rust', version: '1', language: 'Rust', 'display-name': 'rust' },
    ];
    expect(selectCompilers(list, getLanguage('cpp')).map((c) => c.name)).toEqual(['gcc-13', 'gcc-head']);
  });
  it('tries a preferred compiler first when one is set', () => {
    const list = [
      { name: 'scala-3.5.1', version: '3.5.1', language: 'Scala', 'display-name': 'scala' },
      { name: 'scala-3.3.4', version: '3.3.4', language: 'Scala', 'display-name': 'scala' },
    ];
    expect(selectCompilers(list, getLanguage('scala'))[0].name).toBe('scala-3.3.4');
  });
  it('builds and reads Piston requests', () => {
    const project = addFile(createProject('python'), 'util.py', '');
    const language = { ...getLanguage('python'), piston: 'python' };
    const request = buildPistonRequest({ ...project, entry: 'main.py' }, language);
    expect((request.files as { name: string }[]).map((f) => f.name)).toEqual(['main.py', 'util.py']);
    expect(parsePistonResponse({ run: { stdout: 'hi', stderr: '', code: 0, signal: null } })).toMatchObject({ stdout: 'hi', exitCode: 0, compileFailed: false });
    expect(parsePistonResponse({ compile: { stderr: 'bad', code: 1 }, run: { code: null } })).toMatchObject({ compileFailed: true, compileOutput: 'bad', exitCode: 1 });
  });
});

describe('explainTrap', () => {
  it('translates traps beginners hit', () => {
    expect(explainTrap('memory access out of bounds')).toMatch(/invalid memory access/);
    expect(explainTrap('Maximum call stack size exceeded')).toMatch(/stack overflow/);
    expect(explainTrap('divide by zero')).toMatch(/division by zero/);
    expect(explainTrap('unreachable')).toMatch(/aborted/);
    expect(explainTrap('something else')).toBe('something else');
  });
});
