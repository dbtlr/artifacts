import type { FC, PropsWithChildren } from 'hono/jsx';

const SECRET_SCRIPT_SRC = '/assets/secret.js';

const wordmark = 'text-center text-lg font-bold tracking-tight text-stone-900 dark:text-ink-100';
const button =
  'mt-4 w-full cursor-pointer border border-stone-900 bg-stone-900 px-3 py-2.5 font-semibold text-white disabled:cursor-wait disabled:opacity-60 dark:border-ink-100 dark:bg-ink-100 dark:text-ink-950';
const title = 'mt-3.5 font-semibold break-words text-stone-900 dark:text-ink-100';
const sub = 'mt-0.5 text-sm text-stone-500 dark:text-ink-400';
const fine = 'mt-2.5 text-center text-sm text-stone-500 dark:text-ink-400';

type SealTone = 'accent' | 'gone' | 'sealed';

const sealTones: Record<SealTone, string> = {
  accent: 'border-amber-600 bg-stone-100 dark:border-accent dark:bg-ink-900',
  gone: 'border-dashed border-stone-300 dark:border-ink-700',
  sealed: 'border-stone-300 bg-stone-100 dark:border-ink-700 dark:bg-ink-900',
};

// The panel at the center of every secret view.
const Seal: FC<PropsWithChildren<{ tone: SealTone }>> = ({ children, tone }) => (
  <div class={`border px-4 py-6 text-center ${sealTones[tone]}`}>{children}</div>
);

type IconShape = 'file' | 'locked' | 'none' | 'open';

const iconPaths: Record<IconShape, string[]> = {
  file: ['M6 3h8l4 4v14H6z', 'M14 3v4h4'],
  locked: ['M5 11h14v9H5z', 'M8 11V8a4 4 0 0 1 8 0v3'],
  none: ['M5 11h14v9H5z', 'M8 11V8a4 4 0 0 1 8 0v3', 'M3 3l18 18'],
  open: ['M5 11h14v9H5z', 'M8 11V8a4 4 0 0 1 7.5-2'],
};

const Icon: FC<{ accent?: boolean; shape: IconShape }> = ({ accent = false, shape }) => (
  <svg
    aria-hidden="true"
    viewBox="0 0 24 24"
    class={`mx-auto size-7 fill-none ${accent ? 'stroke-amber-600 dark:stroke-accent' : 'stroke-stone-500 dark:stroke-ink-400'}`}
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    {iconPaths[shape].map((d) => (
      <path d={d} />
    ))}
  </svg>
);

const Shell: FC<PropsWithChildren<{ data?: Record<string, string> }>> = ({ children, data }) => (
  <main class="mx-auto max-w-sm pt-16" {...data}>
    <p class={wordmark}>
      a<span class="text-amber-600 dark:text-accent">.</span> Muninn
    </p>
    <div class="mt-6">{children}</div>
  </main>
);

// Read, expired, unknown, and malformed ids all get exactly this, so the
// page never tells anyone whether an id existed (ADR-0008).
const UnavailableView: FC<{ hidden?: boolean }> = ({ hidden = false }) => (
  <section id="secret-unavailable" hidden={hidden}>
    <Seal tone="gone">
      <Icon shape="none" />
      <h1 class={title}>Nothing to reveal</h1>
      <p class={sub}>Already read, expired, or never sent</p>
    </Seal>
    <p class={fine}>Ask the sender for a new link.</p>
  </section>
);

export const SecretUnavailablePage: FC = () => (
  <Shell>
    <UnavailableView />
  </Shell>
);

type SecretPageProps = {
  // Shown, as in the mock, as "expires in 23 h".
  expiresIn: string;
  filename: string | null;
  label: string;
};

// A pending secret, sealed until the owner reveals it. Every later view is
// rendered here hidden, and src/client/secret.ts, which holds the key from
// the link's fragment, switches between them. Nothing on the page is secret.
export const SecretPage: FC<SecretPageProps> = ({ expiresIn, filename, label }) => (
  <Shell data={filename === null ? {} : { 'data-filename': filename }}>
    <section id="secret-ready">
      <Seal tone="sealed">
        <Icon shape="locked" />
        <p class="mt-2.5 font-mono tracking-[0.18em] text-stone-500 dark:text-ink-400">
          •••• •••• ••••
        </p>
        <h1 class={title}>{label}</h1>
        {filename === null ? null : <p class={`${sub} font-mono break-all`}>{filename}</p>}
        <p class={sub}>From an agent · expires in {expiresIn}</p>
      </Seal>
      <button id="secret-reveal" type="button" class={button}>
        Reveal once
      </button>
      <p class={fine}>Revealing deletes it from Muninn.</p>
      <noscript>
        <p class={`${fine} text-red-700 dark:text-red-400`}>
          Revealing needs JavaScript. Turn it on and reload this page.
        </p>
      </noscript>
    </section>
    <section id="secret-text" hidden>
      <Seal tone="accent">
        <Icon accent shape="open" />
        <h2 class={title}>{label}</h2>
        <pre
          id="secret-value"
          class="mt-2.5 max-h-80 overflow-auto border border-stone-200 bg-stone-50 p-2.5 text-left font-mono text-sm break-all whitespace-pre-wrap text-stone-900 select-all dark:border-ink-800 dark:bg-[#0a0b0d] dark:text-ink-100"
        />
      </Seal>
      <button id="secret-copy" type="button" class={button}>
        Copy
      </button>
      <p class={fine}>Deleted from Muninn. This page holds the only copy.</p>
    </section>
    <section id="secret-file" hidden>
      <Seal tone="accent">
        <Icon accent shape="file" />
        <h2 id="secret-file-name" class={`${title} font-mono break-all`} />
        <p class={sub}>
          <span id="secret-file-size" /> · {label}
        </p>
      </Seal>
      <button id="secret-download" type="button" class={button}>
        Download
      </button>
      <p class={fine}>Deleted from Muninn. Download it now.</p>
    </section>
    <UnavailableView hidden />
    <script src={SECRET_SCRIPT_SRC} type="module" />
  </Shell>
);
