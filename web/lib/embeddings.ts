import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

// Local, in-process embeddings — no external API (self-hosted requirement).
// multilingual-e5-small: 384 dims, solid zh/en retrieval, ~100MB, CPU-friendly.
// e5 models expect "query: " / "passage: " prefixes.
const MODEL = "Xenova/multilingual-e5-small";

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

export function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    extractorPromise = pipeline("feature-extraction", MODEL, {
      dtype: "q8", // quantized: faster CPU inference, negligible quality loss
    });
    // A failed load (e.g. first-boot download hiccup) must not poison the
    // singleton forever — clear so the next call retries.
    extractorPromise.catch(() => {
      extractorPromise = null;
    });
  }
  return extractorPromise;
}

async function embed(text: string): Promise<number[]> {
  const extractor = await getExtractor();
  const out = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(out.data as Float32Array);
}

export function embedPassage(text: string): Promise<number[]> {
  return embed(`passage: ${text}`);
}

export function embedQuery(text: string): Promise<number[]> {
  return embed(`query: ${text}`);
}
