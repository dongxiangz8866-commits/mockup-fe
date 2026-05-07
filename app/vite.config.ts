import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';

function scanModels() {
  const dir = path.resolve(__dirname, 'public/models');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
    .sort()
    .map((f) => {
      const stat = fs.statSync(path.join(dir, f));
      return { url: `/models/${f}`, mtime: Math.floor(stat.mtimeMs) };
    });
}

export default defineConfig({
  plugins: [react()],
  server: { port: 5174, strictPort: true },
  define: {
    __MODELS__: JSON.stringify(scanModels()),
  },
});
