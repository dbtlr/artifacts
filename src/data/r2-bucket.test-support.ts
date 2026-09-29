import type { R2BucketBinding } from './r2-bucket.js';

export type ListableR2Bucket = R2BucketBinding & {
  list: () => Promise<{ objects: { key: string }[]; truncated: boolean }>;
};

// Deletes every object, so each test starts from an empty bucket whatever
// storage isolation the test runtime provides.
export async function emptyBucket(bucket: ListableR2Bucket): Promise<void> {
  const { objects, truncated } = await bucket.list();
  await Promise.all(objects.map(({ key }) => bucket.delete(key)));
  if (truncated) {
    await emptyBucket(bucket);
  }
}
