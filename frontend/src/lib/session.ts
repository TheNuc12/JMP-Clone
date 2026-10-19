// Saving and restoring sessions (.sift files) and autosave.

export const SESSION_EXTENSION = '.sift'

export function isSessionFile(file: File): boolean {
  return file.name.toLowerCase().endsWith(SESSION_EXTENSION)
}

/** Download the whole workspace (tables, row states, reports) as a .sift file. */
export function downloadSession(): void {
  throw new Error('Saving sessions is not implemented yet.')
}

/** Replace the workspace with a .sift file's contents. */
export async function openSessionFile(file: File): Promise<void> {
  void file
  throw new Error('Opening sessions is not implemented yet.')
}

/** Start saving the workspace in the browser as it changes; returns a function that stops it. */
export function startAutosave(): () => void {
  return () => {}
}
