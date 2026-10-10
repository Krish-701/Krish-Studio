import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Worker-side libs that must not be bundled into the server build.
  serverExternalPackages: ["bullmq", "ioredis", "@prisma/client", "unpdf"],
  experimental: { serverActions: { bodySizeLimit: "200mb" } },
  images: { unoptimized: true },
};

export default nextConfig;
