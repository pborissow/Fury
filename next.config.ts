import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native/ESM packages that must NOT be bundled by Next — loaded as real node
  // modules in the server runtime. codemogger + its Turso native driver and the
  // transformers embedder run in-process for code search (lib/codemoggerServer.ts).
  serverExternalPackages: [
    'kokoro-js',
    'codemogger',
    '@tursodatabase/database',
    '@huggingface/transformers',
  ],
  devIndicators: false,
};

export default nextConfig;
