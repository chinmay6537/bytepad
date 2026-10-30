import { expect, test, type Page } from '@playwright/test';
import { decodeProject, encodeProject } from '../src/core/share';
import { addFile, createProject, type Project } from '../src/core/project';

const COMPILE_TIMEOUT = 180_000;

// CI skips these, so an outage at a free third-party service cannot block a deploy.
const skipInCi = () => test.skip(!!process.env.CI, 'depends on a third-party service');

async function open(page: Page, project?: Project) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(project ? `./#${encodeProject(project)}` : './');
  // Run stays disabled until the app has started, including the first-visit reload.
  await expect(page.getByTestId('run')).toBeEnabled({ timeout: 60_000 });
  expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(true);
  return errors;
}

const terminalText = (page: Page) =>
  page.locator('.xterm-rows').evaluate((rows) => [...rows.children].map((row) => row.textContent).join('\n'));

const expectTerminal = (page: Page, text: string | RegExp, timeout = COMPILE_TIMEOUT) =>
  expect.poll(() => terminalText(page), { timeout }).toMatch(text);

const typeInTerminal = async (page: Page, text: string) => {
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type(text);
};

const source = (language: string, content: string, extra: Partial<Project> = {}): Project => {
  const project = createProject(language);
  return { ...project, files: [{ name: project.entry, content }], ...extra };
};

test('Python: input() pauses for real typing, and the second run starts clean', async ({ page }) => {
  const errors = await open(page, source('python', 'a = input("first? ")\nb = input("second? ")\nprint("got", a, b)\n'));
  await page.getByTestId('run').click();
  await expectTerminal(page, /first\?/);
  await expect(page.getByTestId('status')).toHaveText('Running');
  await typeInTerminal(page, 'one\n');
  await expectTerminal(page, /second\?/);
  await typeInTerminal(page, 'two\n');
  await expectTerminal(page, /got one two/);
  await expectTerminal(page, /Exit code 0/);

  await page.getByTestId('run').click();
  await expectTerminal(page, /first\?/);
  await expect.poll(() => terminalText(page)).not.toMatch(/got/);
  await page.getByTestId('stop').click();
  await expect(page.getByTestId('status')).toHaveText('Stopped');
  expect(errors).toEqual([]);
});

test('Python: multi-file import, traceback marker, file output', async ({ page }) => {
  let project = source('python', 'import util\nopen("out.txt", "w").write("saved")\nprint(util.twice(21))\nutil.boom()\n');
  project = { ...addFile(project, 'util.py', 'def twice(x):\n    return x * 2\n\ndef boom():\n    raise ValueError("nope")\n'), active: 'main.py' };
  await open(page, project);
  await page.getByTestId('run').click();
  await expectTerminal(page, /42/);
  await expectTerminal(page, /ValueError: nope/);
  await expectTerminal(page, /Exit code 1/);
  await expect(page.getByTestId('file-list')).toContainText('out.txt');
});

test('Python: debugger steps, shows variables and honours breakpoints', async ({ page }) => {
  await open(page, source('python', 'def add(a, b):\n    total = a + b\n    return total\n\nx = 2\ny = add(x, 3)\nprint(y)\n'));
  await page.getByTestId('debug').click();
  await expect(page.getByTestId('status')).toHaveText(/Paused at main\.py:1/, { timeout: 60_000 });
  await page.getByTestId('dbg-over').click();
  await expect(page.getByTestId('status')).toHaveText(/Paused at main\.py:5/);
  await page.getByTestId('dbg-over').click();
  await expect(page.getByTestId('status')).toHaveText(/Paused at main\.py:6/);
  await expect(page.getByTestId('dbg-state')).toContainText('x');
  await page.locator('#dbg-into').click();
  await expect(page.getByTestId('status')).toHaveText(/Paused at main\.py:2/);
  await expect(page.locator('#dbg-stack')).toContainText('add');
  await expect(page.locator('#dbg-vars')).toContainText('a');
  await page.locator('#dbg-continue').click();
  await expectTerminal(page, /5/);
  await expectTerminal(page, /Exit code 0/);
});

test('Python: a breakpoint set in the margin stops the program there', async ({ page }) => {
  await open(page, source('python', 'a = 1\nb = 2\nc = 3\nd = 4\nprint(a + b + c + d)\n'));
  const lineFour = page.locator('.margin-view-overlays > div').nth(3);
  const box = (await lineFour.boundingBox())!;
  await page.mouse.click(box.x + 8, box.y + box.height / 2);
  await expect(page.locator('.breakpoint-glyph')).toHaveCount(1);
  await page.getByTestId('debug').click();
  await expect(page.getByTestId('status')).toHaveText(/Paused at main\.py:1/, { timeout: 60_000 });
  await page.locator('#dbg-continue').click();
  await expect(page.getByTestId('status')).toHaveText(/Paused at main\.py:4/);
  await expect(page.locator('#dbg-vars')).toContainText('c');
  await page.locator('#dbg-continue').click();
  await expectTerminal(page, /^10\s*$/m);
});

test('JavaScript: top-level await works in any position', async ({ page }) => {
  await open(page, source('javascript', 'console.log("value", await Promise.resolve(5));\nfor await (const x of [1]) console.log("x", x);\n'));
  await page.getByTestId('run').click();
  await expectTerminal(page, /value 5/, 30_000);
  await expectTerminal(page, /x 1/);
  await expectTerminal(page, /Exit code 0/);
});

test('Files: create, run a non-default entry, rename and delete', async ({ page }) => {
  await open(page, source('python', 'print("from main")\n'));
  await page.getByTestId('new-file').click();
  await page.getByTestId('dialog-input').fill('../evil.py');
  await page.keyboard.press('Enter');
  await expect(page.locator('.error-text')).toContainText('not allowed');
  await page.getByTestId('dialog-input').fill('second.py');
  await page.keyboard.press('Enter');
  const list = page.getByTestId('file-list');
  await expect(list).toContainText('second.py');

  await page.locator('.view-lines').click();
  await page.keyboard.type('print("from second")');
  await list.getByText('second.py').hover();
  await page.getByRole('button', { name: 'Run second.py first' }).click();
  await page.getByTestId('run').click();
  await expectTerminal(page, /from second/, 60_000);

  await list.getByText('second.py').hover();
  await page.getByRole('button', { name: 'Rename second.py' }).click();
  await page.getByTestId('dialog-input').fill('renamed.py');
  await page.keyboard.press('Enter');
  await expect(list).toContainText('renamed.py');
  await page.getByTestId('run').click();
  await expect(page.getByTestId('status')).toHaveText('Finished');
  await expectTerminal(page, /from second/);

  await list.getByText('renamed.py').hover();
  await page.getByRole('button', { name: 'Delete renamed.py' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(list).not.toContainText('renamed.py');
  await page.getByTestId('run').click();
  await expectTerminal(page, /from main/);
});

test('A shared link can be undone, and saved work comes back', async ({ page }) => {
  await open(page);
  await page.getByTestId('tab-input').click();
  await page.getByTestId('stdin').fill('my-own-work');
  await page.waitForTimeout(500);
  await page.goto(`./#${encodeProject(source('python', 'print("from a link")\n'))}`);
  await expect(page.locator('#toast')).toContainText('Opened a shared project');
  await expect(page.getByTestId('stdin')).toHaveValue('');
  await page.getByRole('button', { name: 'Restore my previous work' }).click();
  await expect(page.getByTestId('stdin')).toHaveValue('my-own-work');
});

test('C: real Clang, live scanf, prompt appears before input', async ({ page }) => {
  const errors = await open(page, source('c', '#include <stdio.h>\nint main(void){int a,b;printf("a? ");scanf("%d",&a);printf("b? ");scanf("%d",&b);printf("sum=%d\\n",a+b);return 3;}\n'));
  await page.getByTestId('run').click();
  await expectTerminal(page, /a\?/);
  await typeInTerminal(page, '20\n');
  await expectTerminal(page, /b\?/);
  await typeInTerminal(page, '22\n');
  await expectTerminal(page, /sum=42/);
  await expectTerminal(page, /Exit code 3/);
  expect(errors).toEqual([]);
});

test('C: compile errors mark the editor and name the line', async ({ page }) => {
  await open(page, source('c', '#include <stdio.h>\nint main(void){\n  int x = \n  return 0;\n}\n'));
  await page.getByTestId('run').click();
  await expect(page.getByTestId('status')).toHaveText('Compile failed', { timeout: COMPILE_TIMEOUT });
  await expectTerminal(page, /main\.c:\d+:\d+: error/);
});

test('C: file I/O, crash explanation', async ({ page }) => {
  await open(page, source('c', '#include <stdio.h>\nint main(void){FILE*f=fopen("o.txt","w");fprintf(f,"written");fclose(f);f=fopen("o.txt","r");char b[16]={0};fgets(b,16,f);fclose(f);puts(b);volatile int *p=(int*)0xFFFFFFF0;return *p;}\n'));
  await page.getByTestId('run').click();
  await expectTerminal(page, /written/);
  await expectTerminal(page, /invalid memory access/);
  await expect(page.getByTestId('file-list')).toContainText('o.txt');
});

test('C++: STL, bits/stdc++.h and multiple files; a throw explains itself', async ({ page }) => {
  let project = source('cpp', '#include <bits/stdc++.h>\n#include "util.h"\nusing namespace std;\nint main(){vector<int> v{3,1,2};sort(v.begin(),v.end());map<string,int> m;m["k"]=twice(v[2]);cout<<m["k"]<<endl;throw runtime_error("boom");}\n');
  project = addFile(project, 'util.h', 'int twice(int);\n');
  project = { ...addFile(project, 'util.cpp', '#include "util.h"\nint twice(int x){return x*2;}\n'), active: 'main.cpp' };
  await open(page, project);
  await page.getByTestId('run').click();
  await expectTerminal(page, /Exit code/);
  const text = await terminalText(page);
  expect(text).toMatch(/^6\s*$/m);
  expect(text).toMatch(/threw a C\+\+ exception/);
  expect(text).toMatch(/Exit code 134/);
});

test('C++: exceptions work through the GCC cloud option', async ({ page }) => {
  skipInCi();
  await open(page, source('cpp', '#include <iostream>\n#include <stdexcept>\nint main(){try{throw std::runtime_error("boom");}catch(const std::exception& e){std::cout<<"caught "<<e.what()<<std::endl;}}\n'));
  await page.getByTestId('tab-input').click();
  await page.getByTestId('use-cloud').check();
  await expect(page.getByTestId('engine')).toHaveText('Cloud: Wandbox');
  await page.getByTestId('run').click();
  await expectTerminal(page, /caught boom/, 90_000);
});

test('Stop kills an infinite loop, and the compiler stays warm', async ({ page }) => {
  await open(page, source('c', 'int main(void){for(;;){}}\n'));
  await page.getByTestId('run').click();
  await expect(page.getByTestId('status')).toHaveText('Running', { timeout: COMPILE_TIMEOUT });
  await page.getByTestId('stop').click();
  await expect(page.getByTestId('status')).toHaveText('Stopped');
  const started = Date.now();
  await page.getByTestId('run').click();
  await expect(page.getByTestId('status')).toHaveText('Running', { timeout: 30_000 });
  expect(Date.now() - started).toBeLessThan(5000);
  await page.getByTestId('stop').click();
});

test('JavaScript: prompt, readline, modules', async ({ page }) => {
  let project = source('javascript', 'const { twice } = require("./util");\nconst readline = require("readline");\nconst n = Number(prompt("n? "));\nconsole.log("twice", twice(n), { a: [1, "x"] });\nconst rl = readline.createInterface({ input: process.stdin });\nrl.on("line", (l) => console.log("line:", l));\nrl.on("close", () => console.log("closed"));\n');
  project = { ...addFile(project, 'util.js', 'exports.twice = (x) => x * 2;\n'), active: 'main.js' };
  await open(page, project);
  await page.getByTestId('run').click();
  await expectTerminal(page, /n\?/, 30_000);
  await typeInTerminal(page, '21\n');
  await expectTerminal(page, /twice 42 \{ a: \[ 1, "x" \] \}/);
  await typeInTerminal(page, 'hello\n');
  await expectTerminal(page, /line: hello/);
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Control+D');
  await expectTerminal(page, /closed/);
  await expectTerminal(page, /Exit code 0/);
});

test('TypeScript: types strip, timers finish, errors keep line numbers', async ({ page }) => {
  await open(page, source('typescript', 'interface P { x: number }\nconst p: P = { x: 1 };\nsetTimeout(() => { console.log("later", p.x); }, 50);\nasync function f(): Promise<number> { return 7; }\nf().then((v) => console.log("async", v));\n'));
  await page.getByTestId('run').click();
  await expectTerminal(page, /async 7/, 30_000);
  await expectTerminal(page, /later 1/);
  await expectTerminal(page, /Exit code 0/);
  await expect(page.getByTestId('run')).toBeEnabled();
  // Opening a share link in a tab that already has the app loaded must also work.
  await page.goto(`./#${encodeProject(source('typescript', 'const a = 1;\n\nnull.boom;\n'))}`);
  await expect(page.locator('#toast')).toContainText('Opened a shared project');
  await page.getByTestId('run').click();
  await expectTerminal(page, /main\.ts:3/, 30_000);
});

test('Tests panel: pass, fail with first differing line, timeout', async ({ page }) => {
  const project: Project = {
    ...source('python', 'n = int(input())\nif n == 3:\n    while True:\n        pass\nprint(n * 2)\n'),
    tests: [
      { id: 'a', name: '', input: '2\n', expected: '4\n' },
      { id: 'b', name: '', input: '5\n', expected: '11\n' },
      { id: 'c', name: '', input: '3\n', expected: '6\n' },
    ],
  };
  await open(page, project);
  await page.getByTestId('tab-tests').click();
  await page.getByTestId('run-tests').click();
  await expect(page.getByTestId('tests-summary')).toContainText('1 of 3 passed', { timeout: 60_000 });
  await expect(page.locator('.test-result.pass')).toContainText('Passed');
  await expect(page.locator('.test-result.fail').first()).toContainText('expected: 11');
  await expect(page.locator('.test-result.fail').first()).toContainText('actual:   10');
  await expect(page.locator('.test-result.fail').last()).toContainText('Timed out');
});

test('Share link round-trips and does not run anything', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await open(page, source('python', 'print("shared-marker")\n', { stdin: 'hello\n' }));
  await expect(page.getByTestId('status')).toHaveText('Ready');
  await expect.poll(() => terminalText(page)).not.toMatch(/shared-marker/);
  await page.getByTestId('share').click();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  const decoded = decodeProject(new URL(link).hash);
  expect(decoded?.files[0].content).toContain('shared-marker');
  expect(decoded?.stdin).toBe('hello\n');
});

test('Damaged share link shows a message and keeps the app working', async ({ page }) => {
  await page.goto('./#p=garbage!!');
  await expect(page.locator('#toast')).toContainText('damaged', { timeout: 30_000 });
  await expect(page.getByTestId('run')).toBeEnabled();
});

test('Work survives a reload, per language', async ({ page }) => {
  await open(page);
  await page.getByTestId('language').selectOption('javascript');
  await page.getByTestId('tab-input').click();
  await page.getByTestId('stdin').fill('remember-me');
  await page.waitForTimeout(500);
  await page.reload();
  await expect(page.getByTestId('run')).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByTestId('language')).toHaveValue('javascript');
  await page.getByTestId('tab-input').click();
  await expect(page.getByTestId('stdin')).toHaveValue('remember-me');
});

test('Cloud: Java runs on Wandbox with stdin from the Input tab', async ({ page }) => {
  skipInCi();
  await open(page);
  await page.getByTestId('language').selectOption('java');
  await expect(page.getByTestId('engine')).toHaveText('Cloud: Wandbox');
  await page.getByTestId('run').click();
  await expectTerminal(page, /Sending your code to wandbox\.org/, 20_000);
  await expectTerminal(page, /Hello, Ada!/, 90_000);
  await expectTerminal(page, /Exit code 0/);
});

test('Phone layout has no horizontal scroll and still runs', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await open(page, source('python', 'print("tiny")\n'));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  // Clipped content does not count as overflow, so check the controls really are on screen.
  for (const id of ['run', 'share', 'tab-debugger', 'status']) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box!.x + box!.width, id).toBeLessThanOrEqual(390);
  }
  await page.getByTestId('run').click();
  await expectTerminal(page, /tiny/, 60_000);
});

test('First visit becomes isolated through the service worker alone, as on GitHub Pages', async ({ page }) => {
  const document = await page.request.get('./');
  expect(document.headers()['cross-origin-embedder-policy']).toBeUndefined();
  await open(page);
  expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(true);
});

test('Optional Python packages load from the CDN under isolation', async ({ page }) => {
  skipInCi();
  await open(page, source('python', 'import numpy as np\nprint("mean", np.array([1, 2, 3]).mean())\n'));
  await page.getByTestId('run').click();
  await expectTerminal(page, /mean 2\.0/, 120_000);
});

test('Python and C keep working offline after a first run', async ({ page, context }) => {
  await open(page, source('python', 'print("offline-ok")\n'));
  await page.getByTestId('run').click();
  await expectTerminal(page, /offline-ok/, 60_000);
  await page.getByTestId('language').selectOption('c');
  await page.getByTestId('run').click();
  await expect(page.getByTestId('status')).toHaveText('Running', { timeout: COMPILE_TIMEOUT });
  await page.getByTestId('stop').click();
  // Let the service worker finish caching before cutting the network.
  await expect.poll(() => page.evaluate(async () => (await (await caches.open('bytepad-shell-v1')).keys()).length), { timeout: 60_000 }).toBeGreaterThan(6);
  await page.waitForTimeout(2000);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId('run')).toBeEnabled({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => self.crossOriginIsolated)).toBe(true);
  await page.getByTestId('run').click();
  await expectTerminal(page, /What's your name\?/, COMPILE_TIMEOUT);
  await typeInTerminal(page, 'Ada\n');
  await expectTerminal(page, /Hello, Ada!/);

  await page.getByTestId('language').selectOption('python');
  await page.getByTestId('run').click();
  await expectTerminal(page, /offline-ok/, 60_000);
  await context.setOffline(false);
});
