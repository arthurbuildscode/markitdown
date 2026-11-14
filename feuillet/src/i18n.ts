import frBase from '@eigenpal/docx-editor-i18n/fr';

/** Libellés absents de la traduction française fournie avec l'éditeur. */
const missing = {
  toolbar: {
    break: 'Saut',
    sectionBreakNextPage: 'Saut de section (page suivante)',
    sectionBreakContinuous: 'Saut de section (continu)',
  },
  formattingBar: {
    commentsAndChanges: 'Commentaires et modifications',
    moreItems: '{count, plural, one {# élément de plus} other {# éléments de plus}}',
  },
  lineSpacing: { label: 'Interligne' },
  font: { other: 'Autres', documentFonts: 'Polices du document' },
  zoom: { zoomOut: 'Zoom arrière', zoomIn: 'Zoom avant', zoomLevel: 'Niveau de zoom' },
  revisions: {
    paragraphMarkInserted: 'Saut de paragraphe inséré',
    paragraphMarkDeleted: 'Saut de paragraphe supprimé',
    paragraphPropertiesChanged: 'Propriétés du paragraphe modifiées',
    rowInserted: 'Ligne insérée',
    rowDeleted: 'Ligne supprimée',
    rowPropertiesChanged: 'Propriétés de la ligne modifiées',
    cellInserted: 'Cellule insérée',
    cellDeleted: 'Cellule supprimée',
    cellMerged: 'Cellules fusionnées',
    cellPropertiesChanged: 'Propriétés de la cellule modifiées',
    tablePropertiesChanged: 'Propriétés du tableau modifiées',
    tableInserted: 'Tableau inséré',
    tableDeleted: 'Tableau supprimé',
  },
  table: { selectTable: 'Sélectionner tout le tableau' },
  imageOverlay: { replaceImage: 'Remplacer l’image…' },
};

type Tree = { [key: string]: unknown };

function merge(base: Tree, extra: Tree): Tree {
  const out: Tree = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const current = out[key];
    out[key] =
      value && typeof value === 'object' && current && typeof current === 'object'
        ? merge(current as Tree, value as Tree)
        : value;
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const fr = merge(frBase as unknown as Tree, missing) as any;
