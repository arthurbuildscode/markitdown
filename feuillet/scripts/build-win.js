'use strict';
/**
 * Construit l'installateur Windows (NSIS) : release/Feuillet-Setup-<version>.exe
 *
 *   npm run dist
 *
 * Fonctionne sous Windows comme sous Linux/macOS. Hors Windows, electron-builder
 * lance normalement l'installateur sous Wine pour en extraire le désinstalleur ;
 * on remplace ici cette étape par l'extraction en JavaScript qu'electron-builder
 * fournit déjà (UninstallerReader), ce qui évite d'avoir à installer Wine.
 */
const path = require('node:path');
const builder = require('electron-builder');

if (process.platform !== 'win32') {
  const { WineVmManager } = require('app-builder-lib/out/vm/WineVm');
  const { UninstallerReader } = require('app-builder-lib/out/targets/nsis/nsisUtil');
  const runUnderWine = WineVmManager.prototype.exec;
  WineVmManager.prototype.exec = function exec(file, args, ...rest) {
    const isInstallerStub = /\.exe$/i.test(file) && (!args || args.length === 0);
    if (!isInstallerStub) return runUnderWine.call(this, file, args, ...rest);
    // Même emplacement que celui attendu par NsisTarget.
    const uninstaller = path.join(path.dirname(file), `${path.basename(file, 'exe')}__uninstaller.exe`);
    return UninstallerReader.exec(file, uninstaller);
  };
}

builder
  .build({
    targets: builder.Platform.WINDOWS.createTarget('nsis', builder.Arch.x64),
    publish: 'never',
  })
  .then((files) => {
    console.log('\nInstallateur généré :');
    files.filter((file) => file.endsWith('.exe')).forEach((file) => console.log(`  ${file}`));
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
