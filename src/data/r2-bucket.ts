// The part of a Workers R2 bucket binding that the R2 adapters use. A real
// `R2Bucket` satisfies it. It is declared here because the Workers runtime
// types are global declarations that clash with the DOM lib this project
// compiles against.
export type R2BucketBinding = {
  delete: (key: string) => Promise<void>;
  get: (key: string) => Promise<{ arrayBuffer: () => Promise<ArrayBuffer> } | null>;
  head: (key: string) => Promise<object | null>;
  put: (key: string, value: Uint8Array) => Promise<unknown>;
};

// Reads an object's bytes, or null when no object is stored under the key.
export async function readObject(bucket: R2BucketBinding, key: string): Promise<Uint8Array | null> {
  const object = await bucket.get(key);
  return object === null ? null : new Uint8Array(await object.arrayBuffer());
}
