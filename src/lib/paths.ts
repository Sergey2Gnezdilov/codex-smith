import fs from "node:fs";
import path from "node:path";

// Resolves symlinks for the existing part of the path so that a link inside
// the workspace cannot point a containment check at a directory outside it.
export function resolveRealPath(candidate: string): string {
  const absolute = path.resolve(candidate);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    const parent = path.dirname(absolute);
    if (parent === absolute) return absolute;
    return path.join(resolveRealPath(parent), path.basename(absolute));
  }
}

export function relativeInside(root: string, candidate: string): string | null {
  const relative = path.relative(
    resolveRealPath(root),
    resolveRealPath(candidate)
  );
  if (relative === "") return "";
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return relative.split(path.sep).join("/");
}

export function isPathInside(root: string, candidate: string): boolean {
  return relativeInside(root, candidate) !== null;
}
