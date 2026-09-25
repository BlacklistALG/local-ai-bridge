/** Return only aggregate counts from a list of queued jobs. */
export function summarizeDepartment(jobs) {
  const byStatus = new Map();
  const byProvider = new Map();
  const count = (buckets, value) => {
    const key = typeof value === 'string' && value.length > 0 ? value : 'unknown';
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  };

  for (const job of jobs) {
    count(byStatus, job?.status);
    count(byProvider, job?.provider);
  }

  return {
    total: jobs.length,
    byStatus: Object.fromEntries(byStatus),
    byProvider: Object.fromEntries(byProvider),
  };
}
