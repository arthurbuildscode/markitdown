/**
 * L'éditeur embarqué est conçu pour le navigateur : son menu « Fichier »
 * télécharge le document, ouvre un sélecteur de fichier HTML et imprime via
 * une fenêtre surgissante. Ces trois gestes sont redirigés ici vers les
 * actions natives de l'application (boîtes de dialogue Windows, vrai fichier
 * sur disque, impression système).
 */
export interface HostActions {
  open(): void;
  save(): void;
  print(): void;
}

let actions: HostActions | null = null;
let installed = false;

function install() {
  installed = true;

  // « Enregistrer » : l'éditeur déclenche le téléchargement d'un blob .docx.
  const anchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
    if (actions && this.download && this.href.startsWith('blob:') && /\.docx$/i.test(this.download)) {
      actions.save();
      return;
    }
    anchorClick.call(this);
  };

  // « Ouvrir » : l'éditeur clique sur un <input type="file" accept=".docx">.
  const inputClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function click(this: HTMLInputElement) {
    if (actions && this.type === 'file' && /docx/i.test(this.accept)) {
      actions.open();
      return;
    }
    inputClick.call(this);
  };

  // « Imprimer » : l'éditeur tente d'ouvrir une fenêtre vide, puis se rabat sur window.print().
  const nativeOpen = window.open.bind(window);
  window.open = ((url?: string | URL, ...rest: [string?, string?]) =>
    url ? nativeOpen(url, ...rest) : null) as typeof window.open;
  window.print = () => actions?.print();
}

export function installHostHooks(next: HostActions): () => void {
  if (!installed) install();
  actions = next;
  return () => {
    if (actions === next) actions = null;
  };
}
