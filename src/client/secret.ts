// The one-time secret page's script (see components/secret-page.tsx). The key
// lives in the view link's fragment, which the browser never sends. It is
// read once and removed from the address bar and history, then sent in the
// Reveal POST body, which burns the secret and returns its bytes. A text
// secret is shown for copying; a file, or bytes that are not UTF-8, is
// offered as a download. Any failure shows the unavailable view.

const FALLBACK_FILENAME = 'secret.bin';

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

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${String(bytes)} bytes` : `${(bytes / 1024).toFixed(1)} KiB`;
}

function decodeText(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function showText(text: string): void {
  element('secret-value').textContent = text;
  const copy = element('secret-copy');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
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

// The secret's bytes, or null when the server refuses or cannot be reached.
async function reveal(id: string, key: string): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const response = await fetch(`/s/${encodeURIComponent(id)}/reveal`, {
      body: new URLSearchParams({ key }),
      cache: 'no-store',
      method: 'POST',
    });
    return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

// Shows what the reveal returned, by the rules at the top of this file.
function showRevealed(bytes: Uint8Array<ArrayBuffer> | null, filename: string | undefined): void {
  if (bytes === null) {
    show('secret-unavailable');
    return;
  }
  const text = filename === undefined ? decodeText(bytes) : null;
  if (text === null) {
    showFile(bytes, filename ?? FALLBACK_FILENAME);
  } else {
    showText(text);
  }
}

function start(): void {
  const main = document.querySelector('main');
  const button = document.querySelector<HTMLButtonElement>('#secret-reveal');
  if (main === null || button === null) {
    return;
  }
  const key = location.hash.slice(1);
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  if (key === '') {
    show('secret-unavailable');
    return;
  }
  const id = location.pathname.split('/').at(-1) ?? '';
  const filename = main.dataset.filename;
  button.addEventListener('click', async () => {
    button.disabled = true;
    showRevealed(await reveal(id, key), filename);
  });
}

start();
