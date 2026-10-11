/** Rows per database statement: large enough to be fast, small enough to stay far below the parameter limit. */
export const CHUNK = 1000;

export const chunks = <T>(items: T[], size = CHUNK): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

/** Runs `work` for every item with at most `limit` calls in flight; results keep the order of the items. */
export async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const at = next++;
        results[at] = await work(items[at]!);
      }
    }),
  );
  return results;
}

/** Inserts rows chunk by chunk and returns how many were really new. */
export async function insertAll<T>(rows: T[], insert: (part: T[]) => Promise<{ count: number }>, size = CHUNK): Promise<number> {
  let created = 0;
  for (const part of chunks(rows, size)) created += (await insert(part)).count;
  return created;
}
