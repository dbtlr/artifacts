// The one-time secret page's script (see components/secret-page.tsx). The key
// lives in the view link's fragment, which the browser never sends. It stays
// in the address bar until Reveal is clicked, so a reload before then still
// works; the click removes it from the address bar and this tab's history
// entry, then sends it in the Reveal POST body, which burns the secret and
// returns its bytes. secret-reveal.ts decides how the bytes are shown and
// what each response means. Every page text is written with textContent.
//
// The owner's new-secret pages load it too, to show and run the form's Show
// toggle and the handle page's Copy handle button.

import { classifyReveal, copyText, keyFromFragment, presentSecret } from './secret-reveal.js';
import type { RevealOutcome } from './secret-reveal.js';

const MISSING_KEY = 'This link is missing its key. Open the full link again.';
const UNREACHABLE = 'Couldn’t reach Muninn. Try again.';

function element(id: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`#${id}`);
  if (found === null) {
    throw new Error(`The secret page has no #${id}`);
  }
  return found;
}

function show(id: string): void {
  for (const section of document.querySelectorAll<HTMLElement>('main section')) {
    section.hidden = section.id !== id;
  }
}

// Shows `message` under the Reveal button, or hides it when null.
function notify(message: string | null): void {
  const notice = element('secret-notice');
  notice.textContent = message ?? '';
  notice.hidden = message === null;
}

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${String(bytes)} bytes` : `${(bytes / 1024).toFixed(1)} KiB`;
}

function showText(text: string): void {
  element('secret-value').textContent = text;
  const copy = element('secret-copy');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(copyText(text));
      copy.textContent = 'Copied';
    } catch {
      copy.textContent = 'Select the text to copy it';
    }
  });
  show('secret-text');
}

function showFile(bytes: Uint8Array<ArrayBuffer>, filename: string): void {
  element('secret-file-name').textContent = filename;
  element('secret-file-size').textContent = formatSize(bytes.byteLength);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  element('secret-download').addEventListener('click', () => {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
  });
  show('secret-file');
}

type RevealResult =
  | { bytes: Uint8Array<ArrayBuffer>; outcome: 'revealed' }
  | { outcome: Exclude<RevealOutcome, 'revealed'> };

// What the reveal returned. A request that never got an answer is worth a
// retry, like a server error.
async function reveal(id: string, key: string): Promise<RevealResult> {
  try {
    const response = await fetch(`/s/${encodeURIComponent(id)}/reveal`, {
      body: new URLSearchParams({ key }),
      cache: 'no-store',
      method: 'POST',
    });
    const outcome = classifyReveal(response.status);
    return outcome === 'revealed'
      ? { bytes: new Uint8Array(await response.arrayBuffer()), outcome }
      : { outcome };
  } catch {
    return { outcome: 'retry' };
  }
}

function showRevealed(bytes: Uint8Array<ArrayBuffer>, filename: string | undefined): void {
  const presentation = presentSecret(bytes, filename);
  if (presentation.kind === 'text') {
    showText(presentation.text);
  } else {
    showFile(bytes, presentation.filename);
  }
}

function start(): void {
  const main = document.querySelector('main');
  const button = document.querySelector<HTMLButtonElement>('#secret-reveal');
  if (main === null || button === null) {
    return;
  }
  const key = keyFromFragment(location.hash);
  if (key === null) {
    button.disabled = true;
    notify(MISSING_KEY);
    return;
  }
  const id = location.pathname.split('/').at(-1) ?? '';
  const filename = main.dataset.filename;
  button.addEventListener('click', async () => {
    button.disabled = true;
    notify(null);
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    const result = await reveal(id, key);
    if (result.outcome === 'revealed') {
      showRevealed(result.bytes, filename);
    } else if (result.outcome === 'gone') {
      show('secret-unavailable');
    } else {
      notify(UNREACHABLE);
      button.disabled = false;
    }
  });
}

// Copies the handle exactly as shown, with no newline, so a pasted handle
// parses. Without this script the button stays hidden and the handle is
// selectable text.
function startHandleCopy(button: HTMLButtonElement): void {
  const handle = element('secret-handle').textContent?.trim() ?? '';
  button.hidden = false;
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(handle);
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Select the handle to copy it';
    }
  });
}

// Shows the form's secret field in clear, or masks it again. Without this
// script the toggle stays hidden and the field stays masked.
function startMaskToggle(button: HTMLButtonElement): void {
  const field = element('secret-content');
  button.hidden = false;
  button.addEventListener('click', () => {
    const masked = field.toggleAttribute('data-masked');
    button.textContent = masked ? 'Show' : 'Hide';
    button.setAttribute('aria-pressed', String(!masked));
  });
}

const handleCopy = document.querySelector<HTMLButtonElement>('#secret-handle-copy');
const maskToggle = document.querySelector<HTMLButtonElement>('#secret-content-toggle');
if (handleCopy !== null) {
  startHandleCopy(handleCopy);
} else if (maskToggle !== null) {
  startMaskToggle(maskToggle);
} else {
  start();
}
