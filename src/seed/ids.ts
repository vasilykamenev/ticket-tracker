import { createHash } from 'node:crypto';

/** Fixed namespace of the demo datasets (random, generated once). Never change it: ids derive from it. */
const NAMESPACE = 'b3f1c2a0-5d1e-4a77-9c2e-6a1f0b7d3e11';

/**
 * A name-based UUID (version 5) of the dataset, the kind of record and its position, e.g. `seedId('takehome-demo', 'ticket', 17)`.
 * The same arguments always give the same id, so reruns upsert instead of duplicating and the dataset's rows
 * can be recognised later (reset, verify) without a registry table. Ids never depend on the random seed.
 */
export function seedId(dataset: string, kind: string, ...parts: Array<string | number>): string {
  const hash = createHash('sha1')
    .update(Buffer.from(NAMESPACE.replace(/-/g, ''), 'hex'))
    .update([dataset, kind, ...parts].join('/'))
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const h = hash.subarray(0, 16).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
