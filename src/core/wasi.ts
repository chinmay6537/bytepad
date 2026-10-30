import type { StdinSource } from './stdio';

// A small WASI preview1 host: enough for programs built with wasi-libc to use
// stdio, files, clocks and random numbers. Files live in memory, and the reason
// to write our own is that fd_read on stdin can block until the user types.

const E = { SUCCESS: 0, BADF: 8, EXIST: 20, INVAL: 28, ISDIR: 31, NOENT: 44, NOSYS: 52, NOTDIR: 54, NOTEMPTY: 55 };
const FILETYPE = { CHARACTER_DEVICE: 2, DIRECTORY: 3, REGULAR_FILE: 4 };
const OFLAGS = { CREAT: 1, DIRECTORY: 2, EXCL: 4, TRUNC: 8 };
const FDFLAGS_APPEND = 1;
const WHENCE = { SET: 0, CUR: 1, END: 2 };
const ROOT_FD = 3;

export class ProcessExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

interface OpenFile {
  path: string;
  position: number;
  append: boolean;
  isDirectory: boolean;
}

export interface WasiOptions {
  args: string[];
  stdin: StdinSource;
  stdout(bytes: Uint8Array): void;
  stderr(bytes: Uint8Array): void;
  files: Map<string, Uint8Array>;
  /** Called before the program may wait, so buffered output is seen first. */
  flush?(): void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function createWasi(options: WasiOptions) {
  const { files } = options;
  const directories = new Set<string>(['']);
  for (const path of files.keys()) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'));
  }
  const fds = new Map<number, OpenFile>();
  let nextFd = ROOT_FD + 1;
  let memory: WebAssembly.Memory;
  const sleeper = typeof SharedArrayBuffer !== 'undefined' ? new Int32Array(new SharedArrayBuffer(4)) : null;

  const view = () => new DataView(memory.buffer);
  const bytes = () => new Uint8Array(memory.buffer);
  const readString = (ptr: number, length: number) => decoder.decode(bytes().slice(ptr, ptr + length));

  function normalize(path: string): string {
    const out: string[] = [];
    for (const part of path.split('/')) {
      if (part === '' || part === '.') continue;
      if (part === '..') out.pop();
      else out.push(part);
    }
    return out.join('/');
  }

  function resolve(dirFd: number, ptr: number, length: number): string | null {
    const base = dirFd === ROOT_FD ? '' : fds.get(dirFd)?.path;
    if (base === undefined) return null;
    return normalize(`${base}/${readString(ptr, length)}`);
  }

  function writeIovecs(iovs: number, count: number, sink: (chunk: Uint8Array) => void): number {
    const dv = view();
    let total = 0;
    for (let i = 0; i < count; i++) {
      const ptr = dv.getUint32(iovs + i * 8, true);
      const length = dv.getUint32(iovs + i * 8 + 4, true);
      if (length > 0) sink(bytes().slice(ptr, ptr + length));
      total += length;
    }
    return total;
  }

  function writeFile(file: OpenFile, chunk: Uint8Array, at: number): void {
    const current = files.get(file.path) ?? new Uint8Array(0);
    const end = at + chunk.length;
    const next = end > current.length ? new Uint8Array(end) : current;
    if (next !== current) next.set(current);
    next.set(chunk, at);
    files.set(file.path, next);
  }

  function readInto(iovs: number, count: number, source: (target: Uint8Array) => number): number {
    const dv = view();
    let total = 0;
    for (let i = 0; i < count; i++) {
      const ptr = dv.getUint32(iovs + i * 8, true);
      const length = dv.getUint32(iovs + i * 8 + 4, true);
      if (length === 0) continue;
      const scratch = new Uint8Array(length);
      const got = source(scratch);
      bytes().set(scratch.subarray(0, got), ptr);
      total += got;
      if (got < length) break;
    }
    return total;
  }

  function writeFilestat(ptr: number, type: number, size: number): void {
    const dv = view();
    for (let offset = 0; offset < 64; offset += 8) dv.setBigUint64(ptr + offset, 0n, true);
    dv.setUint8(ptr + 16, type);
    dv.setBigUint64(ptr + 24, 1n, true);
    dv.setBigUint64(ptr + 32, BigInt(size), true);
  }

  const imports: Record<string, (...args: never[]) => number | void> = {
    args_sizes_get(argc: number, size: number) {
      view().setUint32(argc, options.args.length, true);
      view().setUint32(size, options.args.reduce((sum, arg) => sum + encoder.encode(arg).length + 1, 0), true);
      return E.SUCCESS;
    },
    args_get(argv: number, buffer: number) {
      let cursor = buffer;
      options.args.forEach((arg, index) => {
        const encoded = encoder.encode(arg);
        view().setUint32(argv + index * 4, cursor, true);
        bytes().set(encoded, cursor);
        bytes()[cursor + encoded.length] = 0;
        cursor += encoded.length + 1;
      });
      return E.SUCCESS;
    },
    environ_sizes_get(count: number, size: number) {
      view().setUint32(count, 0, true);
      view().setUint32(size, 0, true);
      return E.SUCCESS;
    },
    environ_get: () => E.SUCCESS,
    clock_res_get(_id: number, out: number) {
      view().setBigUint64(out, 1000n, true);
      return E.SUCCESS;
    },
    clock_time_get(id: number, _precision: bigint, out: number) {
      const ms = id === 0 ? Date.now() : performance.now();
      view().setBigUint64(out, BigInt(Math.round(ms * 1e6)), true);
      return E.SUCCESS;
    },
    random_get(ptr: number, length: number) {
      // getRandomValues refuses shared memory views and more than 64 KiB at a time.
      for (let offset = 0; offset < length; offset += 65536) {
        const chunk = new Uint8Array(Math.min(65536, length - offset));
        crypto.getRandomValues(chunk);
        bytes().set(chunk, ptr + offset);
      }
      return E.SUCCESS;
    },
    sched_yield: () => E.SUCCESS,
    proc_exit(code: number) {
      throw new ProcessExit(code);
    },
    poll_oneoff(subscriptions: number, events: number, count: number, published: number) {
      // Only clock subscriptions matter: this is how sleep() arrives.
      const dv = view();
      let wait = 0;
      for (let i = 0; i < count; i++) {
        const base = subscriptions + i * 48;
        if (dv.getUint8(base + 8) === 0) wait = Math.max(wait, Number(dv.getBigUint64(base + 24, true)) / 1e6);
        const event = events + i * 32;
        dv.setBigUint64(event, dv.getBigUint64(base, true), true);
        dv.setUint16(event + 8, 0, true);
        dv.setUint8(event + 10, dv.getUint8(base + 8));
      }
      options.flush?.();
      if (wait > 0) {
        if (sleeper) Atomics.wait(sleeper, 0, 0, wait);
        else for (const end = performance.now() + wait; performance.now() < end; );
      }
      dv.setUint32(published, count, true);
      return E.SUCCESS;
    },
    fd_prestat_get(fd: number, out: number) {
      if (fd !== ROOT_FD) return E.BADF;
      view().setUint8(out, 0);
      view().setUint32(out + 4, 1, true);
      return E.SUCCESS;
    },
    fd_prestat_dir_name(fd: number, ptr: number) {
      if (fd !== ROOT_FD) return E.BADF;
      bytes()[ptr] = 47; // "/"
      return E.SUCCESS;
    },
    fd_fdstat_get(fd: number, out: number) {
      const dv = view();
      let type: number;
      if (fd <= 2) type = FILETYPE.CHARACTER_DEVICE;
      else if (fd === ROOT_FD) type = FILETYPE.DIRECTORY;
      else if (fds.has(fd)) type = fds.get(fd)!.isDirectory ? FILETYPE.DIRECTORY : FILETYPE.REGULAR_FILE;
      else return E.BADF;
      dv.setUint8(out, type);
      dv.setUint16(out + 2, 0, true);
      dv.setBigUint64(out + 8, 0xffffffffffffffffn, true);
      dv.setBigUint64(out + 16, 0xffffffffffffffffn, true);
      return E.SUCCESS;
    },
    fd_fdstat_set_flags: () => E.SUCCESS,
    fd_advise: () => E.SUCCESS,
    fd_datasync: () => E.SUCCESS,
    fd_sync: () => E.SUCCESS,
    fd_close(fd: number) {
      if (fd <= 2) return E.SUCCESS;
      return fds.delete(fd) ? E.SUCCESS : E.BADF;
    },
    fd_write(fd: number, iovs: number, count: number, written: number) {
      let total: number;
      if (fd === 1) total = writeIovecs(iovs, count, options.stdout);
      else if (fd === 2) total = writeIovecs(iovs, count, options.stderr);
      else {
        const file = fds.get(fd);
        if (!file || file.isDirectory) return E.BADF;
        if (file.append) file.position = files.get(file.path)?.length ?? 0;
        total = writeIovecs(iovs, count, (chunk) => {
          writeFile(file, chunk, file.position);
          file.position += chunk.length;
        });
      }
      view().setUint32(written, total, true);
      return E.SUCCESS;
    },
    fd_pwrite(fd: number, iovs: number, count: number, offset: bigint, written: number) {
      const file = fds.get(fd);
      if (!file || file.isDirectory) return E.BADF;
      let at = Number(offset);
      const total = writeIovecs(iovs, count, (chunk) => {
        writeFile(file, chunk, at);
        at += chunk.length;
      });
      view().setUint32(written, total, true);
      return E.SUCCESS;
    },
    fd_read(fd: number, iovs: number, count: number, read: number) {
      let total: number;
      if (fd === 0) {
        options.flush?.();
        total = readInto(iovs, count, (target) => options.stdin.read(target));
      } else {
        const file = fds.get(fd);
        if (!file) return E.BADF;
        if (file.isDirectory) return E.ISDIR;
        const content = files.get(file.path) ?? new Uint8Array(0);
        total = readInto(iovs, count, (target) => {
          const got = Math.min(target.length, Math.max(0, content.length - file.position));
          target.set(content.subarray(file.position, file.position + got));
          file.position += got;
          return got;
        });
      }
      view().setUint32(read, total, true);
      return E.SUCCESS;
    },
    fd_pread(fd: number, iovs: number, count: number, offset: bigint, read: number) {
      const file = fds.get(fd);
      if (!file || file.isDirectory) return E.BADF;
      const content = files.get(file.path) ?? new Uint8Array(0);
      let at = Number(offset);
      const total = readInto(iovs, count, (target) => {
        const got = Math.min(target.length, Math.max(0, content.length - at));
        target.set(content.subarray(at, at + got));
        at += got;
        return got;
      });
      view().setUint32(read, total, true);
      return E.SUCCESS;
    },
    fd_seek(fd: number, offset: bigint, whence: number, out: number) {
      if (fd <= 2) return 70; // ESPIPE: stdio is not seekable
      const file = fds.get(fd);
      if (!file || file.isDirectory) return E.BADF;
      const size = files.get(file.path)?.length ?? 0;
      const base = whence === WHENCE.SET ? 0 : whence === WHENCE.CUR ? file.position : size;
      const position = base + Number(offset);
      if (position < 0) return E.INVAL;
      file.position = position;
      view().setBigUint64(out, BigInt(position), true);
      return E.SUCCESS;
    },
    fd_tell(fd: number, out: number) {
      const file = fds.get(fd);
      if (!file) return E.BADF;
      view().setBigUint64(out, BigInt(file.position), true);
      return E.SUCCESS;
    },
    fd_filestat_get(fd: number, out: number) {
      if (fd <= 2) {
        writeFilestat(out, FILETYPE.CHARACTER_DEVICE, 0);
        return E.SUCCESS;
      }
      if (fd === ROOT_FD) {
        writeFilestat(out, FILETYPE.DIRECTORY, 0);
        return E.SUCCESS;
      }
      const file = fds.get(fd);
      if (!file) return E.BADF;
      writeFilestat(out, file.isDirectory ? FILETYPE.DIRECTORY : FILETYPE.REGULAR_FILE, files.get(file.path)?.length ?? 0);
      return E.SUCCESS;
    },
    fd_filestat_set_size(fd: number, size: bigint) {
      const file = fds.get(fd);
      if (!file || file.isDirectory) return E.BADF;
      const next = new Uint8Array(Number(size));
      next.set((files.get(file.path) ?? new Uint8Array(0)).subarray(0, next.length));
      files.set(file.path, next);
      return E.SUCCESS;
    },
    fd_readdir(_fd: number, _buffer: number, _length: number, _cookie: bigint, used: number) {
      view().setUint32(used, 0, true);
      return E.SUCCESS;
    },
    path_create_directory(fd: number, ptr: number, length: number) {
      const path = resolve(fd, ptr, length);
      if (path === null) return E.BADF;
      if (directories.has(path) || files.has(path)) return E.EXIST;
      directories.add(path);
      return E.SUCCESS;
    },
    path_filestat_get(fd: number, _flags: number, ptr: number, length: number, out: number) {
      const path = resolve(fd, ptr, length);
      if (path === null) return E.BADF;
      if (directories.has(path)) writeFilestat(out, FILETYPE.DIRECTORY, 0);
      else if (files.has(path)) writeFilestat(out, FILETYPE.REGULAR_FILE, files.get(path)!.length);
      else return E.NOENT;
      return E.SUCCESS;
    },
    path_open(
      dirFd: number, _dirFlags: number, ptr: number, length: number, oflags: number,
      _rightsBase: bigint, _rightsInheriting: bigint, fdFlags: number, out: number,
    ) {
      const path = resolve(dirFd, ptr, length);
      if (path === null) return E.BADF;
      const isDirectory = directories.has(path);
      if (oflags & OFLAGS.DIRECTORY && !isDirectory) return files.has(path) ? E.NOTDIR : E.NOENT;
      if (!isDirectory) {
        if (!files.has(path)) {
          if (!(oflags & OFLAGS.CREAT)) return E.NOENT;
          files.set(path, new Uint8Array(0));
        } else if (oflags & OFLAGS.EXCL) {
          return E.EXIST;
        } else if (oflags & OFLAGS.TRUNC) {
          files.set(path, new Uint8Array(0));
        }
      }
      const fd = nextFd++;
      fds.set(fd, { path, position: 0, append: (fdFlags & FDFLAGS_APPEND) !== 0, isDirectory });
      view().setUint32(out, fd, true);
      return E.SUCCESS;
    },
    path_remove_directory(fd: number, ptr: number, length: number) {
      const path = resolve(fd, ptr, length);
      if (path === null) return E.BADF;
      if (!directories.has(path)) return E.NOENT;
      const prefix = `${path}/`;
      if ([...files.keys(), ...directories].some((entry) => entry.startsWith(prefix))) return E.NOTEMPTY;
      directories.delete(path);
      return E.SUCCESS;
    },
    path_unlink_file(fd: number, ptr: number, length: number) {
      const path = resolve(fd, ptr, length);
      if (path === null) return E.BADF;
      if (directories.has(path)) return E.ISDIR;
      return files.delete(path) ? E.SUCCESS : E.NOENT;
    },
    path_rename(fromFd: number, fromPtr: number, fromLength: number, toFd: number, toPtr: number, toLength: number) {
      const from = resolve(fromFd, fromPtr, fromLength);
      const to = resolve(toFd, toPtr, toLength);
      if (from === null || to === null) return E.BADF;
      const content = files.get(from);
      if (!content) return E.NOENT;
      files.delete(from);
      files.set(to, content);
      return E.SUCCESS;
    },
  };

  return {
    /** Unknown imports report ENOSYS instead of failing at link time. */
    imports(module: WebAssembly.Module): WebAssembly.Imports {
      const table: Record<string, unknown> = {};
      for (const entry of WebAssembly.Module.imports(module)) {
        if (entry.module === 'wasi_snapshot_preview1') table[entry.name] = imports[entry.name] ?? (() => E.NOSYS);
      }
      return { wasi_snapshot_preview1: table as WebAssembly.ModuleImports };
    },
    setMemory(value: WebAssembly.Memory) {
      memory = value;
    },
  };
}

/** Plain-language explanation for the traps beginners actually hit. */
export function explainTrap(message: string): string {
  if (/out of bounds/i.test(message)) return 'invalid memory access (a bad pointer or an array index out of range)';
  if (/call stack|stack overflow/i.test(message)) return 'stack overflow (recursion that never stops, or a very large local array)';
  if (/divide by zero/i.test(message)) return 'division by zero';
  if (/unreachable/i.test(message)) return 'the program aborted (abort(), a failed assert, or an uncaught exception)';
  return message;
}
