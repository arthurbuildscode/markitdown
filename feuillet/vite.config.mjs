import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Politique de sécurité appliquée à l'application livrée : aucun contenu ni
// script distant. Elle n'est pas injectée en développement, où le rechargement
// à chaud de Vite a besoin de scripts en ligne.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' blob: data:",
  "worker-src 'self' blob:",
].join('; ');

const csp = () => ({
  name: 'feuillet-csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
});

// L'interface est chargée en file:// par Electron : chemins relatifs obligatoires.
export default defineConfig({
  base: './',
  plugins: [react(), csp()],
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 6000 },
  server: { port: 5173, strictPort: true },
});
