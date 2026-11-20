export function includePathPrefix(linePrefix: string): string | undefined {
  return /^\s*#\s*include\s*[<"]([^>"]*)$/.exec(linePrefix)?.[1];
}
