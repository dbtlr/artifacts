import type { FC } from 'hono/jsx';

type LoginPageProps = {
  // Shown above the form after a refused attempt.
  error?: string;
  // Where a successful login returns to; already checked to be a local path.
  next: string;
};

// The owner's password form: a plain form POST, so it works without script.
// There is no username field because there is only one owner.
export const LoginPage: FC<LoginPageProps> = ({ error, next }) => (
  <main class="mx-auto max-w-sm pt-16">
    <h1 class="text-lg font-bold tracking-tight text-stone-900 dark:text-ink-100">
      a<span class="text-amber-600 dark:text-accent">.</span> Artifacts
    </h1>
    <form method="post" action="/login" class="mt-6 flex flex-col gap-3">
      <input type="hidden" name="next" value={next} />
      <label for="password" class="text-sm text-stone-700 dark:text-ink-300">
        Password
      </label>
      <input
        id="password"
        name="password"
        type="password"
        autocomplete="current-password"
        required
        autofocus
        class="border border-stone-300 bg-white px-3 py-2 text-stone-900 dark:border-ink-700 dark:bg-ink-900 dark:text-ink-100"
      />
      {error === undefined ? null : (
        <p role="alert" class="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
      <button
        type="submit"
        class="mt-2 cursor-pointer border border-stone-900 bg-stone-900 px-3 py-2 font-semibold text-white dark:border-ink-100 dark:bg-ink-100 dark:text-ink-950"
      >
        Log in
      </button>
    </form>
  </main>
);
