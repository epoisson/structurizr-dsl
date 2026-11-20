/**
 * What `!include` needs from the outside world, and the path rules for local includes.
 *
 * The core never touches a file system. A host supplies file access; ids are opaque strings
 * (a path or a URI) that are `/`-separated, so the same rules work for both.
 */

/** Synchronous file access, used while preprocessing. */
export interface IncludeHost {
  /** The text of a file, or undefined if it does not exist. */
  readFile(id: string): string | undefined;
  /** The ids of the entries of a directory, or undefined if `id` is not a directory. Without this, directory includes are not available. */
  listDirectory?(id: string): string[] | undefined;
  /** The text at an HTTPS URL, or undefined if it cannot be loaded. Without this, URL includes are not available. */
  readUrl?(url: string): string | undefined;
}

/** The same, for hosts where reading is asynchronous (see loadAsync). */
export interface AsyncIncludeHost {
  readFile(id: string): Promise<string | undefined>;
  listDirectory?(id: string): Promise<string[] | undefined>;
  readUrl?(url: string): Promise<string | undefined>;
}

/** Thrown by the cache-backed host loadAsync gives the synchronous code, to ask for a file it does not have yet. */
export class NeedsIO extends Error {
  readonly kind: "file" | "directory" | "url";
  readonly target: string;
  constructor(kind: "file" | "directory" | "url", target: string) {
    super(`needs ${kind} ${target}`);
    this.kind = kind;
    this.target = target;
  }
}

export const isHttps = (t: string): boolean => /^https:\/\//i.test(t);
export const isInsecureUrl = (t: string): boolean => /^http:\/\//i.test(t);
const isUriLike = (t: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(t);

/** Everything before the last `/` of an id. */
export function dirname(id: string): string {
  const i = id.lastIndexOf("/");
  return i < 0 ? "" : id.slice(0, i);
}

export type Resolved = { ok: true; id: string } | { ok: false; code: string; message: string };

/**
 * Resolves a local include target against the including file. Per the Structurizr docs the target must be a relative
 * path to a location in the same directory as the including file or below it, so absolute paths and anything that
 * climbs out with `..` are rejected (`a/../b` is fine: it never leaves the directory).
 */
export function resolveLocalTarget(fromFile: string, target: string): Resolved {
  const t = target.replace(/\\/g, "/");
  if (t.trim() === "") return { ok: false, code: "include-invalid-path", message: "The path of an !include cannot be empty." };
  if (t.startsWith("/") || /^[A-Za-z]:\//.test(t) || isUriLike(t)) {
    return { ok: false, code: "include-outside", message: `'${target}' must be a relative path (inside the including file's directory or below).` };
  }
  const stack: string[] = [];
  for (const seg of t.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (stack.length === 0) {
        return { ok: false, code: "include-outside", message: `'${target}' leaves the including file's directory; includes must stay in that directory or below.` };
      }
      stack.pop();
    } else stack.push(seg);
  }
  const base = dirname(fromFile);
  const encode = isUriLike(fromFile) ? encodeURIComponent : (s: string): string => s;
  const rel = stack.map(encode).join("/");
  const id = rel === "" ? base : base === "" ? rel : `${base}/${rel}`;
  return { ok: true, id };
}

export const isDslFile = (id: string): boolean => /\.dsl$/i.test(id);
