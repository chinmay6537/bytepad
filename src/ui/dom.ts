export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Creates an element. Text always goes through textContent, so shared content cannot inject markup. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Omit<HTMLElementTagNameMap[K], 'style' | 'dataset'>> & { dataset?: Record<string, string> } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { dataset, ...rest } = props;
  Object.assign(node, rest);
  if (dataset) Object.assign(node.dataset, dataset);
  node.append(...children);
  return node;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function toast(message: string, action?: { label: string; run(): void }): void {
  const box = $('toast');
  box.replaceChildren(message);
  if (action) {
    box.append(el('button', { className: 'mini-link', textContent: action.label, onclick: () => { box.hidden = true; action.run(); } }));
  }
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (box.hidden = true), action ? 12000 : 3500);
}

export function askText(title: string, initial: string, validate: (value: string) => string | null): Promise<string | null> {
  const dialog = $<HTMLDialogElement>('dialog');
  return new Promise((resolve) => {
    const input = el('input', { type: 'text', value: initial, spellcheck: false, className: 'field' });
    input.setAttribute('data-testid', 'dialog-input');
    const error = el('p', { className: 'error-text' });
    const submit = () => {
      const problem = validate(input.value.trim());
      if (problem) {
        error.textContent = problem;
        return;
      }
      dialog.close();
      resolve(input.value.trim());
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    });
    dialog.oncancel = () => resolve(null);
    dialog.replaceChildren(
      el('h2', { textContent: title }),
      input,
      error,
      el('div', { className: 'dialog-actions' },
        el('button', { className: 'control', textContent: 'Cancel', onclick: () => { dialog.close(); resolve(null); } }),
        el('button', { className: 'control primary', textContent: 'OK', onclick: submit }),
      ),
    );
    dialog.showModal();
    input.select();
  });
}

export function confirmAction(title: string, body: string, confirmLabel: string): Promise<boolean> {
  const dialog = $<HTMLDialogElement>('dialog');
  return new Promise((resolve) => {
    dialog.oncancel = () => resolve(false);
    dialog.replaceChildren(
      el('h2', { textContent: title }),
      el('p', { textContent: body }),
      el('div', { className: 'dialog-actions' },
        el('button', { className: 'control', textContent: 'Cancel', onclick: () => { dialog.close(); resolve(false); } }),
        el('button', { className: 'control primary', textContent: confirmLabel, onclick: () => { dialog.close(); resolve(true); } }),
      ),
    );
    dialog.showModal();
  });
}

export function showHelp(): void {
  const dialog = $<HTMLDialogElement>('dialog');
  const shortcuts: [string, string][] = [
    ['Ctrl/Cmd + Enter', 'Run'],
    ['Ctrl + C in the terminal', 'Stop the program'],
    ['Ctrl + D in the terminal', 'End of input (EOF)'],
    ['F5', 'Continue while debugging'],
    ['F10 / F11 / Shift + F11', 'Step over / into / out'],
  ];
  dialog.oncancel = null;
  dialog.replaceChildren(
    el('h2', { textContent: 'How Bytepad works' }),
    el('p', { textContent: 'Python, C, C++, JavaScript and TypeScript run on your own device, in a WebAssembly sandbox. They work offline after the first run, and your code stays in this browser.' }),
    el('p', { textContent: 'Other languages are compiled by Wandbox, a free third-party service. Your code is sent there when you press Run, and input must be entered in the Input tab beforehand. Avoid using them for secrets.' }),
    el('p', { textContent: 'Share links carry the whole project in the part of the URL after #, which browsers never send to a server. Anyone with the link can read the code.' }),
    el('table', { className: 'shortcuts' }, el('tbody', {}, ...shortcuts.map(([keys, what]) => el('tr', {}, el('td', {}, el('kbd', { textContent: keys })), el('td', { textContent: what }))))),
    el('div', { className: 'dialog-actions' },
      el('button', { className: 'control primary', textContent: 'Close', onclick: () => dialog.close() }),
    ),
  );
  dialog.showModal();
}
