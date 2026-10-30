export interface Comparison {
  passed: boolean;
  /** 1-indexed line of the first difference, when the outputs differ. */
  line?: number;
  expectedLine?: string;
  actualLine?: string;
}

/** Trailing spaces and blank trailing lines are ignored, as most online judges do. */
export function normalizeOutput(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n').map((line) => line.trimEnd());
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function compareOutput(expected: string, actual: string): Comparison {
  const want = normalizeOutput(expected);
  const got = normalizeOutput(actual);
  const length = Math.max(want.length, got.length);
  for (let i = 0; i < length; i++) {
    if (want[i] !== got[i]) {
      return { passed: false, line: i + 1, expectedLine: want[i] ?? '(no line)', actualLine: got[i] ?? '(no line)' };
    }
  }
  return { passed: true };
}
