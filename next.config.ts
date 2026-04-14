import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ['kokoro-js'],
  devIndicators: false,
};

export default nextConfig;
