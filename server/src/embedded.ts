// Set by the generated entry of the compiled program; null when run from source.
let web: Record<string, string> | null = null;

export function setEmbeddedWeb(files: Record<string, string>): void {
  web = files;
}

export function embeddedWeb(): Record<string, string> | null {
  return web;
}

export function isProgram(): boolean {
  return embeddedWeb() !== null;
}
