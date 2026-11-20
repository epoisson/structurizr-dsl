import { NeedsIO } from "./include.ts";
import type { AsyncIncludeHost, IncludeHost } from "./include.ts";
import { load } from "./load.ts";
import type { LoadResult } from "./load.ts";
import type { ParseOptions } from "./parser.ts";

export type AsyncLoadOptions = Omit<ParseOptions, "host"> & { host: AsyncIncludeHost };

const MAX_FETCHES = 2000;

/**
 * `load` for hosts where file access is asynchronous (the VS Code extension, a browser).
 *
 * The preprocessor is synchronous. So it runs against a cache; when it asks for something the cache does not
 * hold, the cache throws, this fetches it, and the whole (cheap) load runs again. A workspace of n files
 * costs n+1 runs, and the result is identical to what `load` gives with a synchronous host.
 */
export async function loadAsync(source: string, options: AsyncLoadOptions): Promise<LoadResult> {
  const { host: remote, ...rest } = options;
  const files = new Map<string, string | undefined>();
  const dirs = new Map<string, string[] | undefined>();
  const urls = new Map<string, string | undefined>();

  const host: IncludeHost = {
    readFile: (id) => {
      if (files.has(id)) return files.get(id);
      throw new NeedsIO("file", id);
    },
    ...(remote.listDirectory
      ? {
          listDirectory: (id: string) => {
            if (dirs.has(id)) return dirs.get(id);
            throw new NeedsIO("directory", id);
          },
        }
      : {}),
    ...(remote.readUrl
      ? {
          readUrl: (url: string) => {
            if (urls.has(url)) return urls.get(url);
            throw new NeedsIO("url", url);
          },
        }
      : {}),
  };

  for (let fetched = 0; fetched < MAX_FETCHES; fetched++) {
    try {
      return load(source, { ...rest, host });
    } catch (e) {
      if (!(e instanceof NeedsIO)) throw e;
      if (e.kind === "file") files.set(e.target, await remote.readFile(e.target));
      else if (e.kind === "directory") dirs.set(e.target, await remote.listDirectory!(e.target));
      else urls.set(e.target, await remote.readUrl!(e.target));
    }
  }
  throw new Error(`Gave up after reading ${MAX_FETCHES} files: is something including itself through changing paths?`);
}
