/** Opérations exposées par le processus principal (voir electron/preload.js). */
export interface OpenedFile {
  filePath: string;
  name: string;
  /** Contenu au format .docx, quel que soit le format d'origine. */
  data: Uint8Array;
  /** Vrai si le fichier d'origine est un .docx que l'on peut réécrire en place. */
  native: boolean;
  format: string;
}

export type Command =
  | 'new'
  | 'open'
  | 'open-path'
  | 'save'
  | 'save-as'
  | 'save-and-close'
  | 'export-pdf'
  | 'print'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset';

export interface FeuilletApi {
  getStartup(): Promise<{ file: string | null; userName: string; version: string }>;
  showOpenDialog(): Promise<string | null>;
  readFile(filePath: string): Promise<OpenedFile>;
  showSaveDialog(options: { kind: 'docx' | 'pdf'; defaultPath?: string }): Promise<string | null>;
  writeFile(filePath: string, data: Uint8Array): Promise<boolean>;
  exportPdf(filePath: string, html: string): Promise<boolean>;
  print(html: string): Promise<{ success: boolean; reason: string | null }>;
  newWindow(filePath?: string | null): Promise<void>;
  setState(state: { dirty: boolean; title: string }): void;
  closeWindow(): void;
  showError(title: string, detail?: string): Promise<unknown>;
  pathForFile(file: File): string;
  onCommand(callback: (command: Command, payload?: string) => void): () => void;
}

declare global {
  interface Window {
    feuillet: FeuilletApi;
  }
}

export const api: FeuilletApi = window.feuillet;

/** Extensions que « Ouvrir » sait lire (doit rester aligné sur electron/converters). */
export const OPEN_EXTENSIONS = [
  'docx', 'docm', 'dotx', 'dotm', 'doc', 'dot', 'rtf', 'odt', 'txt', 'md', 'markdown', 'html', 'htm',
];

export function baseName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

export function stripExtension(name: string): string {
  return name.replace(/\.[^.\\/]+$/, '');
}

export function extensionOf(name: string): string {
  const match = /\.([^.\\/]+)$/.exec(name);
  return match ? match[1].toLowerCase() : '';
}
