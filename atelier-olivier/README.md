# L'Atelier d'Olivier

Logiciel de retouche photo pour Windows, simple et élégant, conçu pour Olivier Denise.
Tout le traitement se fait sur l'ordinateur : aucune photo n'est envoyée sur Internet.

## Installation (Windows 10 ou 11, 64 bits)

1. Double-cliquer sur `Atelier-Olivier-Installation.exe`.
2. Windows affiche « Windows a protégé votre ordinateur » parce que le programme n'est pas
   signé par un éditeur commercial : cliquer sur **Informations complémentaires**, puis sur
   **Exécuter quand même**.
3. L'installation se fait toute seule (aucune question, pas besoin d'être administrateur),
   l'atelier s'ouvre et un raccourci « L'Atelier d'Olivier » apparaît sur le Bureau.

Pour désinstaller : Paramètres Windows → Applications → « L'Atelier d'Olivier ».

## Ce que fait l'atelier

| Onglet | Fonctions |
| --- | --- |
| **Réglages** | Amélioration automatique en un clic · exposition, luminosité, contraste, hautes lumières, ombres, blancs, noirs · température, teinte, vibrance, saturation, nuance · netteté, clarté, réduction du bruit · vignettage, grain, fondu · noir et blanc (avec filtres rouge, jaune, vert, bleu) · virages sépia, olive, or, sélénium, cyanotype, cuivre · teinte séparée des ombres et des hautes lumières |
| **Filtres** | 13 ambiances prêtes à l'emploi, dont la signature « Huile d'olive » |
| **Recadrer** | Recadrage libre ou au format (carré, 4:3, 3:2, 16:9, A4), redressement de l'horizon, rotations et miroirs |
| **Magie** | Amélioration de la définition par IA (restauration, agrandissement ×2 et ×4) · colorisation automatique des photos noir et blanc |

Formats lus : JPEG, PNG, WebP, GIF, BMP, TIFF, AVIF, HEIC/HEIF (iPhone), SVG, ICO.
Formats enregistrés : **JPEG, PNG, PDF, WebP, TIFF, AVIF, BMP, GIF**, avec choix de la qualité et de la taille.

Raccourcis : `Ctrl+O` ouvrir · `Ctrl+S` enregistrer · `Ctrl+Z` / `Ctrl+Y` annuler / rétablir ·
`Espace` (maintenu) voir l'original · molette pour zoomer · double-clic pour passer à 100 % ·
double-clic sur un curseur pour le remettre à zéro. On peut aussi glisser-déposer une photo
dans la fenêtre ou la coller depuis le presse-papiers.

## Pour les curieux : fabriquer l'installateur

Prérequis : Node.js 22+, Python 3.10+ (uniquement pour convertir les modèles IA, une fois).

```bash
npm install
pip install torch onnx onnxruntime numpy
python scripts/convert_models.py   # télécharge et convertit les deux modèles dans models/
npm start                          # lance l'atelier en développement
npm test                           # test de bout en bout (ouverture, exports, recadrage, IA)
npm run dist                       # crée release/Atelier-Olivier-Installation.exe
```

Sous Windows `npm run dist` fonctionne tel quel ; sous Linux ou macOS il faut `wine` (utilisé
par electron-builder pour finaliser l'installateur).

Organisation du code :

- `main.js`, `preload.js` — fenêtre Electron, dialogues et accès aux fichiers ;
- `src/engine.js` — moteur de rendu WebGL2 (réglages en temps réel, export par tuiles) ;
- `src/params.js` — réglages, filtres et amélioration automatique ;
- `src/codecs.js`, `src/codec-worker.js` — lecture et écriture des formats d'image ;
- `src/ai.js`, `src/ai-worker.js` — super-résolution et colorisation (ONNX Runtime Web) ;
- `src/app.js`, `src/index.html`, `src/styles.css` — interface.

## Briques open source utilisées

| Composant | Rôle | Licence |
| --- | --- | --- |
| [Electron](https://www.electronjs.org/) | socle de l'application | MIT |
| [ONNX Runtime Web](https://onnxruntime.ai/) | exécution locale des modèles IA | MIT |
| [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) (`realesr-general-x4v3`) | amélioration de la définition | BSD-3-Clause |
| [Colorization](https://github.com/richzhang/colorization) (`siggraph17`, R. Zhang et al.) | colorisation automatique | BSD-2-Clause |
| [pdf-lib](https://pdf-lib.js.org/) | écriture des PDF | MIT |
| [UTIF](https://github.com/photopea/UTIF.js) | lecture et écriture TIFF | MIT |
| [gifenc](https://github.com/mattdesl/gifenc) | écriture GIF | MIT |
| [libheif-js](https://github.com/catdad-experiments/libheif-js) | lecture HEIC/HEIF | LGPL-3.0 |
| [jSquash AVIF](https://github.com/jamsinclair/jSquash) (libavif) | écriture AVIF | Apache-2.0 |
| [Fraunces](https://github.com/undercasetype/Fraunces), [Inter](https://rsms.me/inter/) | typographies | SIL OFL 1.1 |
