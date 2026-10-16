export interface HyperglobOptions {
  /** Base directory to search from. Defaults to process.cwd(). */
  cwd?: string;
  /** Obey .gitignore / .git/info/exclude / global gitignore. Default: true. */
  gitignore?: boolean;
  /** Obey .ignore and .agentignore files. Default: true. */
  ignoreFiles?: boolean;
  /** Include dotfiles / dot-directories. Default: false. */
  dot?: boolean;
  /** Maximum traversal depth relative to cwd. */
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
   */
  pathsOnly?: boolean;
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
  size?: number;
  modified?: Date;
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

export declare class HyperglobStream implements AsyncIterable<Entry>, PromiseLike<Entry[]> {
  constructor(patterns: string | string[], options?: HyperglobOptions);
  [Symbol.asyncIterator](): AsyncGenerator<Entry>;
  collect(): Promise<Entry[]>;
  then<TResult1 = Entry[], TResult2 = never>(
    onFulfilled?: ((value: Entry[]) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2>;
  catch<TResult = never>(
    onRejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
  ): Promise<Entry[] | TResult>;
  finally(onFinally?: (() => void) | null): Promise<Entry[]>;
}

/**
 * Streaming API (PRD §5.1). Returns an AsyncIterable that is also awaitable
 * (awaiting it collects all entries into an array).
 */
export declare function hyperglob(
  patterns: string | string[],
  options?: HyperglobOptions
): HyperglobStream;

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
export declare function version(): string;

export default hyperglob;
