import { generateDataset } from './dataset.js';

/**
 * The ids that belong to a dataset. They depend only on the dataset name, never on the random seed, so a reset or
 * a verification finds the rows of a dataset created with any seed. Obtained by generating the dataset in memory
 * (a second or so for the default size), which keeps the id scheme in one place. A dataset made with `--tickets N`
 * has more ids, so N has to be given again.
 */
export function ownedIds(dataset: string, tickets?: number) {
  const data = generateDataset({ dataset, tickets });
  return {
    userIds: data.users.map((u) => u.id),
    agentIds: data.agents.map((a) => a.id),
    groupIds: data.groups.map((g) => g.id),
    customerIds: data.customers.map((c) => c.id),
    ticketIds: data.tickets.map((t) => t.id),
    /** The keys the generator would use; rows of other seeds and of added files are found through the database. */
    seedObjectKeys: data.attachments.map((a) => a.objectKey),
  };
}

export type OwnedIds = ReturnType<typeof ownedIds>;
