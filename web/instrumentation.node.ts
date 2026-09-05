import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";

// Langfuse reads LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASEURL from env.
const langfuseSpanProcessor = new LangfuseSpanProcessor();

const sdk = new NodeSDK({
  serviceName: process.env.OTEL_SERVICE_NAME ?? "coworker-agent",
  spanProcessors: [langfuseSpanProcessor],
});

sdk.start();

// Warm the local embedding model at boot so the first chat request doesn't pay
// the ~15s model load (or a first-time download) inside its own deadline.
import("@/lib/embeddings")
  .then((m) => m.getExtractor())
  .then(() => console.log("[embeddings] model warm"))
  .catch((e) => console.warn("[embeddings] warmup failed:", e?.message ?? e));
