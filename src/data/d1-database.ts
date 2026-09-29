// The part of a Workers D1 database binding that the D1 adapter uses. A real
// `D1Database` satisfies it. It is declared here because the Workers runtime
// types are global declarations that clash with the DOM lib this project
// compiles against.
export type D1PreparedStatementBinding = {
  all: () => Promise<{ results: Record<string, unknown>[] }>;
  bind: (...values: (number | string | null)[]) => D1PreparedStatementBinding;
  first: () => Promise<Record<string, unknown> | null>;
  run: () => Promise<{ meta: { changes: number } }>;
};

export type D1DatabaseBinding = {
  prepare: (query: string) => D1PreparedStatementBinding;
};
