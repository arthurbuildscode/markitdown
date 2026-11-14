import type { ReactNode } from 'react';

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export function AppLogo() {
  return (
    <svg width="34" height="34" viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="#1f5fbf" />
      <path d="M19 12h19l9 9v29a3 3 0 0 1-3 3H19a3 3 0 0 1-3-3V15a3 3 0 0 1 3-3z" fill="#fff" />
      <path d="M38 12v6a3 3 0 0 0 3 3h6z" fill="#b9d2f5" />
      <rect x="22" y="28" width="19" height="3" rx="1.5" fill="#1f5fbf" />
      <rect x="22" y="35" width="19" height="3" rx="1.5" fill="#1f5fbf" />
      <rect x="22" y="42" width="12" height="3" rx="1.5" fill="#1f5fbf" />
    </svg>
  );
}

interface Props {
  dirty: boolean;
  onNew(): void;
  onOpen(): void;
  onSave(): void;
  onSaveAs(): void;
  onExportPdf(): void;
  onPrint(): void;
}

/** Barre d'accès rapide affichée à droite du titre du document. */
export function FileActions({ dirty, onNew, onOpen, onSave, onSaveAs, onExportPdf, onPrint }: Props) {
  return (
    <div className="feuillet-actions" role="toolbar" aria-label="Fichier">
      <span className="feuillet-actions__status" aria-live="polite">
        {dirty ? 'Modifications non enregistrées' : ''}
      </span>
      <button type="button" onClick={onNew} title="Nouveau document (Ctrl+N)">
        <Icon>
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
          <path d="M14 3v5h5M12 12v6M9 15h6" />
        </Icon>
        Nouveau
      </button>
      <button type="button" onClick={onOpen} title="Ouvrir un document (Ctrl+O)">
        <Icon>
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </Icon>
        Ouvrir
      </button>
      <button type="button" className="feuillet-actions__primary" onClick={onSave} title="Enregistrer (Ctrl+S)">
        <Icon>
          <path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
          <path d="M7 3v5h8V3M7 21v-7h10v7" />
        </Icon>
        Enregistrer
      </button>
      <button type="button" onClick={onSaveAs} title="Enregistrer sous… (Ctrl+Maj+S)">
        Enregistrer sous
      </button>
      <button type="button" onClick={onExportPdf} title="Exporter en PDF">
        PDF
      </button>
      <button type="button" onClick={onPrint} title="Imprimer (Ctrl+P)" aria-label="Imprimer">
        <Icon>
          <path d="M7 9V3h10v6M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2" />
          <path d="M7 14h10v7H7z" />
        </Icon>
      </button>
    </div>
  );
}
