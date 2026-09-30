import type { MetadataRoute } from 'next';

// Served at /manifest.webmanifest and linked from every page by Next.
// Icons are rendered from the traced logo by design/logo/icons.mjs — see design/README.md.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Fury IDE',
    short_name: 'Fury',
    description: 'A powerful IDE for AI-assisted development',
    start_url: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#090808',
    theme_color: '#0a0a0a',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
