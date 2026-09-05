import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // React Compiler OFF: assistant-ui components ship their own memoization and
  // can misbehave under double-compilation.
  reactCompiler: false,
  // Next dev blocks cross-origin loads of /_next/* by default -> browsers hitting
  // the server by IP never get the JS chunks (no hydration, all buttons dead).
  allowedDevOrigins: ["23.146.248.110", "140.121.80.210", "100.64.0.16", "127.0.0.1", "localhost"],
  // transformers.js pulls in onnxruntime-node (native binding) — keep it out of
  // the bundler and require it at runtime instead.
  serverExternalPackages: ["@huggingface/transformers", "onnxruntime-node"],
};

export default nextConfig;
