export interface HyperglobOptions {
  /** Base directory to search from. Defaults to process.cwd(). */
  cwd?: string;
  /** Obey .gitignore / .git/info/exclude / global gitignore. Default: true. */
  gitignore?: boolean;
  /** Obey .ignore and .agentignore files. Default: true. */
  ignoreFiles?: boolean;
  /** Include dotfiles / dot-directories. Default: false. */
  dot?: boolean;
  /** Maximum traversal depth below the search root (the patterns' static base), matching fast-glob's `deep`. */
  maxDepth?: number;
  /** Walker threads. 0 = auto. */
  threads?: number;
  /** Populate size / modified on entries. Default: true. */
  stats?: boolean;
  /** Only return files. Default: true. */
  onlyFiles?: boolean;
  /** Follow symlinked directories. Default: false. */
  followSymlinks?: boolean;
  /** Read file contents and attach them as entry.content / entry.buffer. Default: false. */
  content?: boolean;
  /** Alias of `content`. */
  withContent?: boolean;
  /** Additional glob patterns to exclude. */
  ignore?: string | string[];
  /**
   * Return relative path strings instead of Entry objects.
   * The fast path for pure path discovery. Default: false.
   *
   * Honoured by `hyperglobSync` (returns `string[]`) and by the streaming
   * `hyperglob()` API (the stream yields `string` values, not `Entry`).
   */
  pathsOnly?: boolean;
  /**
   * Use (and maintain) the warm index snapshot at `<cwd>/.hyperglob/`.
   * Repeat queries validate directory mtimes and answer in memory;
   * metadata for matched entries is refreshed with a stat, content is
   * always read fresh. Sync APIs only. Default: false.
   */
  index?: boolean;
}

export interface Entry {
  /** Absolute path. */
  path: string;
  /** Path relative to cwd, posix separators. */
  relativePath: string;
  name: string;
  extension: string;
  isFile: boolean;
  isDir: boolean;
  /** File size in bytes. Present only when `stats` is not false. */
  size?: number;
  /**
   * Last-modified timestamp.
   *
   * Absent (undefined) when `stats: false` — there is no date to report,
   * so the property is omitted rather than returning an Invalid Date.
   */
  modified?: Date;
  /** Last-modified time in ms since the epoch. Present only when `stats` is not false. */
  modifiedMs?: number;
  /** File content as string (only when `content: true`). */
  content?: string;
  /** File content as Buffer (only when `content: true`). */
  buffer?: Buffer;
}

export interface ParsedQuery {
  patterns: string[];
  negatives: string[];
  selectors: string[];
}

/**
 * Entry implementation used by the synchronous API.
 *
 * `modified` and `buffer` are lazy prototype getters; they are not own
 * enumerable properties, so `Object.keys(entry)` does not list them.
 */
export declare class HyperEntry {
  path: string;
  relativePath: string;
  name: string;
  extension: string;
  isFile: boolean;
  isDir: boolean;
  size?: number;
  modifiedMs?: number;
  content?: string;
  readonly modified: Date | undefined;
  readonly buffer: Buffer | undefined;
  toJSON(): Record<string, unknown>;
}

/** The stream yields `Entry` objects, or `string` paths when `pathsOnly` is set. */
export declare class HyperglobStream<T = Entry> implements AsyncIterable<T>, PromiseLike<T[]> {
  constructor(patterns: string | string[], options?: HyperglobOptions);
  [Symbol.asyncIterator](): AsyncGenerator<T>;
  collect(): Promise<T[]>;
  then<TResult1 = T[], TResult2 = never>(
    onFulfilled?: ((value: T[]) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2>;
  catch<TResult = never>(
    onRejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
  ): Promise<T[] | TResult>;
  finally(onFinally?: (() => void) | null): Promise<T[]>;
}

/**
 * Streaming API (PRD §5.1). Returns an AsyncIterable that is also awaitable
 * (awaiting it collects all entries into an array).
 *
 * With `options.pathsOnly: true` the stream yields relative path strings
 * instead of `Entry` objects.
 */
export declare function hyperglob(
  patterns: string | string[],
  options?: HyperglobOptions & { pathsOnly?: false }
): HyperglobStream<Entry>;
export declare function hyperglob(
  patterns: string | string[],
  options: HyperglobOptions & { pathsOnly: true }
): HyperglobStream<string>;

/** Synchronous batch API (PRD §5.2). */
export declare function hyperglobSync(
  patterns: string | string[],
  options?: HyperglobOptions & { pathsOnly?: false }
): Entry[];
export declare function hyperglobSync(
  patterns: string | string[],
  options: HyperglobOptions & { pathsOnly: true }
): string[];

export declare function parseQuery(input: string): ParsedQuery;

/**
 * Import-graph query: every JS/TS file under `cwd` that imports `target`
 * (a cwd-relative path, e.g. 'src/hooks.ts') directly or transitively.
 *
 * Throws when the target does not exist under `cwd`.
 */
export declare function hyperglobDependents(
  target: string,
  options?: HyperglobOptions
): string[];

export declare function version(): string;

// ---------------------------------------------------------------------------
// native binding (low level)
// ---------------------------------------------------------------------------

/** A single raw entry as returned by the native layer. */
export interface NativeEntry {
  path: string;
  relativePath: string;
  name: string;
  extension: string;
  size: number;
  modifiedMs: number;
  isFile: boolean;
  isDir: boolean;
  content?: string;
}

/** Columnar transport payload returned by `native.scanColumnsSync`. */
export interface NativeColumns {
  count: number;
  /** NUL-joined absolute paths. */
  paths: string;
  /** NUL-joined cwd-relative paths. */
  relativePaths: string;
  /** NUL-joined file names. */
  names: string;
  /** NUL-joined extensions. */
  extensions: string;
  /** Buffer of little-endian f64 pairs: [size, modifiedMs] per entry. */
  numbers: Buffer;
  /** Buffer of bit flags per entry: bit 0 = isFile, bit 1 = isDir. */
  flags: Buffer;
  /** File contents (one entry per match, or empty when not requested). */
  contents: string[];
  /** Buffer of per-entry "has content" flags. */
  hasContent: Buffer;
}

/** A batch of raw entries from the incremental scanner. */
export interface NativeBatch {
  entries: NativeEntry[];
  done: boolean;
}

/** A batch of relative paths from the incremental paths-only scanner. */
export interface NativePathBatch {
  /** Relative paths, NUL-joined into one string. */
  paths: string;
  done: boolean;
}

/**
 * Incremental scanner handle.
 *
 * Obtained from `native.createScanner(...)`; it is not a top-level export
 * of the package.
 */
export interface Scanner {
  /** Fetch the next batch of entries. */
  nextBatch(max?: number): NativeBatch;
  /** Release the scanner. Safe to call more than once. */
  close(): void;
}

/**
 * Incremental paths-only scanner handle.
 *
 * Obtained from `native.createPathsScanner(...)`; it is not a top-level
 * export of the package.
 */
export interface PathsScanner {
  /** Fetch the next batch of relative paths (NUL-joined). */
  nextBatch(max?: number): NativePathBatch;
  /** Release the scanner. Safe to call more than once. */
  close(): void;
}

export interface Native {
  /** Version of the native addon. */
  version(): string;
  /** One-shot scan returning raw entries. */
  scanSync(patterns: string[], optionsJson?: string | null): NativeEntry[];
  /** One-shot scan returning only relative paths (NUL-joined). */
  scanPathsSync(patterns: string[], optionsJson?: string | null): string;
  /** One-shot scan returning the columnar transport payload. */
  scanColumnsSync(patterns: string[], optionsJson?: string | null): NativeColumns;
  /** Create an incremental scanner. */
  createScanner(patterns: string[], optionsJson?: string | null): Scanner;
  /** Create an incremental paths-only scanner. */
  createPathsScanner(patterns: string[], optionsJson?: string | null): PathsScanner;
  /** Transitive importers of `targetRel` (cwd-relative). */
  dependentsOfSync(targetRel: string, optionsJson?: string | null): string;
  /** Parse a query string into its patterns / negatives / selectors. */
  parseQueryJson(input: string): string;
  /** Constructor of the incremental scanner class. */
  Scanner: new () => Scanner;
  /** Constructor of the incremental paths-only scanner class. */
  PathsScanner: new () => PathsScanner;
}

/** The raw NAPI binding. Advanced / unstable. */
export declare const native: Native;

/** Load the native addon, throwing a descriptive error if it is unavailable. */
export declare function loadNative(): Native;

/** Path of the native addon file that would be loaded. */
export declare function nativeFilename(): string;

export default hyperglob;
