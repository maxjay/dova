import open from 'open';

/** Opens a URL in the user's default browser. Cross-platform via the `open` package. */
export async function openInBrowser(url: string): Promise<void> {
  await open(url);
}
