import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DocxEditor, createEmptyDocument, type DocxEditorRef } from '@eigenpal/docx-editor-react';
import { api, baseName, extensionOf, OPEN_EXTENSIONS, stripExtension, type Command } from './api';
import { fr } from './i18n';
import { buildPrintHtml } from './print';
import { installHostHooks } from './hostHooks';
import { AppLogo, FileActions } from './FileActions';

const APP_NAME = 'Feuillet';

/** Page A4, marges de 2,5 cm (en twips) — les valeurs par défaut de Word en français. */
const BLANK_PAGE = {
  pageWidth: 11906,
  pageHeight: 16838,
  marginTop: 1417,
  marginBottom: 1417,
  marginLeft: 1417,
  marginRight: 1417,
};

/** Polices proposées : celles livrées avec Windows et Office. */
const FONT_FAMILIES = [
  'Calibri', 'Cambria', 'Arial', 'Times New Roman', 'Georgia', 'Verdana', 'Tahoma', 'Trebuchet MS',
  'Segoe UI', 'Garamond', 'Century Gothic', 'Palatino Linotype', 'Book Antiqua', 'Candara', 'Constantia',
  'Corbel', 'Courier New', 'Consolas', 'Comic Sans MS', 'Impact',
];

interface DocumentInfo {
  /** Change à chaque nouveau document pour repartir d'un éditeur neuf. */
  key: number;
  /** Contenu .docx, ou null pour un document vierge. */
  buffer: ArrayBuffer | null;
  /** Fichier .docx dans lequel « Enregistrer » écrit, s'il y en a un. */
  filePath: string | null;
  /** Chemin proposé par « Enregistrer sous » (document importé d'un autre format). */
  suggestedPath: string | null;
  name: string;
}

const BLANK: DocumentInfo = { key: 0, buffer: null, filePath: null, suggestedPath: null, name: 'Document1' };

function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // Electron préfixe les erreurs venant du processus principal.
  return text.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
}

export function App() {
  const editorRef = useRef<DocxEditorRef>(null);
  const [doc, setDoc] = useState<DocumentInfo>(BLANK);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [author, setAuthor] = useState('');
  const [started, setStarted] = useState(false);

  // Les commandes (menus, raccourcis) lisent l'état courant sans se réabonner.
  const docRef = useRef(doc);
  docRef.current = doc;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  /** L'éditeur signale des « changements » pendant le chargement : on les ignore. */
  const acceptChangesRef = useRef(false);
  const busyRef = useRef(false);

  const blankDocument = useMemo(() => createEmptyDocument(BLANK_PAGE), []);

  const loadPath = useCallback(async (filePath: string) => {
    setBusy(`Ouverture de ${baseName(filePath)}…`);
    try {
      const file = await api.readFile(filePath);
      const data = file.data;
      const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      acceptChangesRef.current = false;
      setDoc((previous) => ({
        key: previous.key + 1,
        buffer,
        filePath: file.native ? file.filePath : null,
        suggestedPath: file.native ? null : `${stripExtension(file.filePath)}.docx`,
        name: file.native ? file.name : stripExtension(file.name),
      }));
      setDirty(false);
    } catch (error) {
      await api.showError(`Impossible d’ouvrir « ${baseName(filePath)} ».`, errorMessage(error));
    } finally {
      setBusy(null);
    }
  }, []);

  /** Ouvre dans cette fenêtre si elle est vierge, sinon dans une nouvelle. */
  const openPath = useCallback(
    async (filePath: string) => {
      const pristine = !dirtyRef.current && !docRef.current.filePath && !docRef.current.buffer;
      if (pristine) await loadPath(filePath);
      else await api.newWindow(filePath);
    },
    [loadPath],
  );

  const open = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const filePath = await api.showOpenDialog();
      if (filePath) await openPath(filePath);
    } finally {
      busyRef.current = false;
    }
  }, [openPath]);

  const save = useCallback(async (saveAs = false): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    try {
      const current = docRef.current;
      let target = saveAs ? null : current.filePath;
      if (!target) {
        target = await api.showSaveDialog({
          kind: 'docx',
          defaultPath: current.filePath ?? current.suggestedPath ?? `${current.name}.docx`,
        });
        if (!target) return false;
      }
      const buffer = await editorRef.current?.save();
      if (!buffer) throw new Error('Le document n’a pas pu être préparé pour l’enregistrement.');
      await api.writeFile(target, new Uint8Array(buffer));
      setDoc((previous) => ({ ...previous, filePath: target, suggestedPath: null, name: baseName(target!) }));
      setDirty(false);
      return true;
    } catch (error) {
      await api.showError('L’enregistrement a échoué.', errorMessage(error));
      return false;
    } finally {
      busyRef.current = false;
    }
  }, []);

  const printHtml = useCallback(async () => {
    const html = await buildPrintHtml(document, docRef.current.name);
    if (!html) throw new Error('Le document n’est pas encore affiché.');
    return html;
  }, []);

  const exportPdf = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const current = docRef.current;
      const source = current.filePath ?? current.suggestedPath ?? current.name;
      const target = await api.showSaveDialog({ kind: 'pdf', defaultPath: `${stripExtension(source)}.pdf` });
      if (!target) return;
      setBusy('Export en PDF…');
      await api.exportPdf(target, await printHtml());
    } catch (error) {
      await api.showError('L’export en PDF a échoué.', errorMessage(error));
    } finally {
      setBusy(null);
      busyRef.current = false;
    }
  }, [printHtml]);

  const print = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const result = await api.print(await printHtml());
      if (!result.success && result.reason && !/cancel/i.test(result.reason)) {
        throw new Error(result.reason);
      }
    } catch (error) {
      await api.showError('L’impression a échoué.', errorMessage(error));
    } finally {
      busyRef.current = false;
    }
  }, [printHtml]);

  const newDocument = useCallback(() => {
    void api.newWindow(null);
  }, []);

  const zoomBy = useCallback((delta: number | null) => {
    const editor = editorRef.current;
    if (!editor) return;
    const next = delta === null ? 1 : Math.round((editor.getZoom() + delta) * 10) / 10;
    editor.setZoom(Math.min(3, Math.max(0.3, next)));
  }, []);

  // Démarrage : fichier passé en argument, nom d'utilisateur.
  useEffect(() => {
    let cancelled = false;
    void api.getStartup().then(async ({ file, userName }) => {
      if (cancelled) return;
      setAuthor(userName);
      if (file) await loadPath(file);
      setStarted(true);
    });
    return () => {
      cancelled = true;
    };
  }, [loadPath]);

  // Commandes des menus natifs.
  useEffect(() => {
    const handlers: Record<Command, (payload?: string) => void> = {
      new: newDocument,
      open: () => void open(),
      'open-path': (payload) => payload && void openPath(payload),
      save: () => void save(),
      'save-as': () => void save(true),
      'save-and-close': () => void save().then((saved) => saved && api.closeWindow()),
      'export-pdf': () => void exportPdf(),
      print: () => void print(),
      'zoom-in': () => zoomBy(0.1),
      'zoom-out': () => zoomBy(-0.1),
      'zoom-reset': () => zoomBy(null),
    };
    return api.onCommand((command, payload) => handlers[command]?.(payload));
  }, [newDocument, open, openPath, save, exportPdf, print, zoomBy]);

  // Les actions « Fichier » intégrées à l'éditeur passent par les boîtes de dialogue natives.
  useEffect(
    () => installHostHooks({ open: () => void open(), save: () => void save(), print: () => void print() }),
    [open, save, print],
  );

  // Titre de la fenêtre et état « modifié ».
  useEffect(() => {
    const title = `${doc.name}${dirty ? ' *' : ''} – ${APP_NAME}`;
    document.title = title;
    api.setState({ dirty, title });
  }, [doc.name, dirty]);

  // Glisser-déposer d'un document sur la fenêtre.
  useEffect(() => {
    const droppedDocument = (event: DragEvent) => {
      const file = event.dataTransfer?.files?.[0];
      return file && OPEN_EXTENSIONS.includes(extensionOf(file.name)) ? file : null;
    };
    const onDragOver = (event: DragEvent) => {
      const types = event.dataTransfer?.types;
      if (!types || !Array.from(types).includes('Files')) return;
      const item = event.dataTransfer?.items?.[0];
      // Les images restent gérées par l'éditeur (insertion dans le document).
      if (item && item.type.startsWith('image/')) return;
      event.preventDefault();
    };
    const onDrop = (event: DragEvent) => {
      const file = droppedDocument(event);
      if (!file) return;
      event.preventDefault();
      event.stopPropagation();
      void openPath(api.pathForFile(file));
    };
    window.addEventListener('dragover', onDragOver, true);
    window.addEventListener('drop', onDrop, true);
    return () => {
      window.removeEventListener('dragover', onDragOver, true);
      window.removeEventListener('drop', onDrop, true);
    };
  }, [openPath]);

  // Après le chargement d'un document, on laisse l'éditeur se stabiliser
  // avant de considérer ses notifications comme des modifications de l'utilisateur.
  useEffect(() => {
    acceptChangesRef.current = false;
    const timer = window.setTimeout(() => {
      acceptChangesRef.current = true;
    }, 800);
    return () => window.clearTimeout(timer);
  }, [doc.key, started]);

  const handleChange = useCallback(() => {
    if (acceptChangesRef.current) setDirty(true);
  }, []);

  const handleError = useCallback((error: Error) => {
    void api.showError('Une erreur est survenue dans l’éditeur.', errorMessage(error));
  }, []);

  const renderLogo = useCallback(() => <AppLogo />, []);
  const renderActions = useCallback(
    () => (
      <FileActions
        dirty={dirty}
        onNew={newDocument}
        onOpen={() => void open()}
        onSave={() => void save()}
        onSaveAs={() => void save(true)}
        onExportPdf={() => void exportPdf()}
        onPrint={() => void print()}
      />
    ),
    [dirty, newDocument, open, save, exportPdf, print],
  );

  if (!started) return <div className="feuillet-splash">Chargement…</div>;

  return (
    <>
      <DocxEditor
        key={doc.key}
        ref={editorRef}
        {...(doc.buffer ? { documentBuffer: doc.buffer } : { document: blankDocument })}
        mode="editing"
        author={author || undefined}
        i18n={fr}
        showRuler
        rulerUnit="cm"
        showHelpMenu={false}
        fontFamilies={FONT_FAMILIES}
        documentName={doc.name}
        documentNameEditable={false}
        renderLogo={renderLogo}
        renderTitleBarRight={renderActions}
        onChange={handleChange}
        onError={handleError}
      />
      {busy && (
        <div className="feuillet-busy" role="status">
          <div className="feuillet-busy__box">{busy}</div>
        </div>
      )}
    </>
  );
}
