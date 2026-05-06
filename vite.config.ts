import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const root = process.cwd();
  const env = loadEnv(mode, root, '');
  const exampleEnvPath = path.resolve(root, '.env.example');
  const exampleEnv = fs.existsSync(exampleEnvPath)
    ? dotenv.parse(fs.readFileSync(exampleEnvPath))
    : {};
  const mergedEnv = {
    ...exampleEnv,
    ...env,
  };

  // Favor non-empty values from .env.example if the environment variable is empty
  const finalGeminiKey = env.VITE_GEMINI_API_KEY || env.GEMINI_API_KEY || mergedEnv.GEMINI_API_KEY || null;
  const finalApiKey = env.VITE_API_KEY || env.API_KEY || mergedEnv.API_KEY || null;

  return {
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(finalGeminiKey),
      'process.env.API_KEY': JSON.stringify(finalApiKey),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
