// Minimal glob: '*' matches any run of characters except ':' so that
// "demo:*" matches every tool on the demo server but not other servers,
// and a bare "*" still matches everything via the special case below.
export function globMatch(pattern: string, value: string): boolean {
  if (pattern === '*') return true
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^:]*')
  return new RegExp(`^${escaped}$`).test(value)
}
