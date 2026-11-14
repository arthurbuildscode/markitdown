# Feuillet

Traitement de texte pour Windows, dans l'esprit de Microsoft Word : il ouvre, modifie et enregistre
les documents `.docx`, et sait lire les anciens `.doc` ainsi que les formats courants (`.rtf`, `.odt`,
`.txt`, `.md`, `.html`). Il s'installe comme un logiciel classique (assistant d'installation,
raccourcis, désinstallation, association aux fichiers Word).

## Installer

Lancer `Feuillet-Setup-<version>.exe`, puis suivre l'assistant. L'installateur n'est pas signé :
Windows SmartScreen peut afficher un avertissement au premier lancement (« Informations
complémentaires » → « Exécuter quand même »).

## Fonctions

- Édition paginée fidèle à la mise en page Word : styles, polices, tailles, couleurs, alignement,
  listes, tableaux, images, liens, en-têtes et pieds de page, sauts de page, table des matières,
  commentaires et suivi des modifications.
- Fichier : nouveau, ouvrir, enregistrer, enregistrer sous, documents récents, export PDF, impression.
- Une fenêtre par document ; glisser-déposer d'un fichier sur la fenêtre ; double-clic sur un `.docx`
  ou un `.doc` dans l'Explorateur.
- Rechercher / remplacer, annuler / rétablir, zoom, règle, plan du document.

| Format | Ouverture | Enregistrement |
| --- | --- | --- |
| `.docx`, `.docm` | natif | natif |
| `.dotx`, `.dotm` (modèles) | oui, comme nouveau document | en `.docx` |
| `.doc`, `.dot` (Word 97-2003) | texte, mise en forme, titres, listes, tableaux | en `.docx` |
| `.rtf`, `.odt` | texte, mise en forme, titres, listes, tableaux | en `.docx` |
| `.txt`, `.md`, `.html` | oui | en `.docx` |
| `.pdf` | non | export |

Un document ouvert depuis un autre format que `.docx` est converti : « Enregistrer » propose alors
de créer un `.docx` à côté de l'original, qui n'est jamais modifié.

### Limites connues

- Conversion `.doc` / `.rtf` / `.odt` : les en-têtes, pieds de page et notes ne sont pas repris, ni les
  images (sauf les PNG et JPEG des fichiers `.rtf`) ;
  les fichiers Word 6/95 sont ouverts en texte brut ; les fichiers protégés par mot de passe sont refusés.
- Les images vectorielles WMF/EMF ne s'affichent pas.
- Pas de correcteur orthographique.
- Les polices sont celles installées sur l'ordinateur ; rien n'est téléchargé (l'application
  fonctionne entièrement hors ligne).

## Développement

Prérequis : Node.js 22 ou plus récent.

```bash
npm install
npm start            # construit l'interface et lance l'application
npm run test:e2e     # test de bout en bout (sous Linux sans écran : xvfb-run -a npm run test:e2e)
npm run dist         # produit release/Feuillet-Setup-<version>.exe
```

`npm run dist` fonctionne sous Windows comme sous Linux ou macOS, sans Wine
(voir `scripts/build-win.js`).

Pour travailler sur l'interface avec rechargement à chaud : `npm run dev` dans un terminal,
`npm run dev:app` dans un autre.

### Organisation

| Chemin | Rôle |
| --- | --- |
| `electron/main.js` | Processus principal : fenêtres, menus, boîtes de dialogue, fichiers, impression et PDF |
| `electron/preload.js` | Seul pont entre l'interface (isolée, sans accès à Node) et le processus principal |
| `electron/converters/` | Import : tout format est ramené à un `.docx` en mémoire (`doc.js`, `rtf.js`, `odt.js`) |
| `src/` | Interface (React) autour du composant d'édition |
| `tests/e2e.js` | Parcours complet dans l'application réelle (Playwright + Electron) |

Le moteur d'édition est [docx-editor](https://github.com/eigenpal/docx-editor) (Apache-2.0), conçu
pour le navigateur. `src/hostHooks.ts` redirige ses actions « Ouvrir », « Enregistrer » et « Imprimer »
vers les fonctions natives de l'application ; sa version est figée dans `package.json` car ce
raccordement dépend de son fonctionnement interne.

## Licences

Code de Feuillet : MIT. Composants tiers : Electron (MIT), docx-editor (Apache-2.0),
@turbodocx/html-to-docx, word-extractor, marked, JSZip, xmldom (MIT).
