/** Shared compiled-Bun detection for general subprocess and product entry. */
export function isCompiledBunMain(main: string): boolean {
  return main.startsWith("/$bunfs/") || /^[A-Za-z]:\/~BUN\//.test(main)
}
