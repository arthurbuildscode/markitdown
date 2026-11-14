// Fabrique l'installateur Windows (release/Atelier-Olivier-Installation.exe).
import { build, Platform, Arch } from 'electron-builder';
import { existsSync } from 'node:fs';

for (const model of ['models/upscale-x4.onnx', 'models/colorize.onnx']) {
  if (!existsSync(model)) {
    console.error(`Modèle manquant : ${model} — lancez d'abord « python scripts/convert_models.py »`);
    process.exit(1);
  }
}

// « --dir-local » : empaquette pour le système courant sans installateur (sert aux tests).
const localDir = process.argv.includes('--dir-local');

await build({
  targets: localDir ? Platform.current().createTarget(['dir'], Arch.x64) : Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
  config: {
    appId: 'fr.denise.atelier-olivier',
    productName: 'Atelier Olivier',
    copyright: 'Fait avec affection pour Olivier Denise',
    directories: { output: 'release', buildResources: 'build' },
    files: ['main.js', 'preload.js', 'package.json', 'dist/**/*', 'build/icon.png'],
    extraResources: [{ from: 'models', to: 'models', filter: ['*.onnx'] }],
    electronLanguages: ['fr', 'en-US'],
    compression: 'maximum',
    win: { icon: 'build/icon.ico', legalTrademarks: "L'Atelier d'Olivier" },
    nsis: {
      oneClick: true,
      perMachine: false,
      runAfterFinish: true,
      createDesktopShortcut: 'always',
      createStartMenuShortcut: true,
      shortcutName: "L'Atelier d'Olivier",
      uninstallDisplayName: "L'Atelier d'Olivier",
      artifactName: 'Atelier-Olivier-Installation.${ext}',
      installerIcon: 'build/icon.ico',
      uninstallerIcon: 'build/icon.ico',
      installerLanguages: ['fr_FR'],
      language: '1036',
    },
    publish: null,
  },
});
