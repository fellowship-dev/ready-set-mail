/** Run `fn` over `items` with at most `limit` in flight. `fn` must not throw. */
export async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => { while (next < items.length) await fn(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
