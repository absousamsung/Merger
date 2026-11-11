// models.ts — model registry with alias normalization and env overrides.
// Reality check: gpt-image-2-6/flare-text-to-image and grok-imagine-video-1-5-preview
// verified against the real kie.ai Jobs API with a live call (2026-11-11).
export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string;
  aliases: string[];
  type: MediaType;
  providers: ProviderId[];
  providerModel: Record<ProviderId, string>;
}

const KIE_IMAGE_MODEL = process.env.KIE_IMAGE_MODEL || "gpt-image-2-6/flare-text-to-image";
const KIE_VIDEO_MODEL = process.env.KIE_VIDEO_MODEL || "grok-imagine-video-1-5-preview";
const COMETAPI_IMAGE_MODEL = process.env.COMETAPI_IMAGE_MODEL || "gpt-image-2.6-flare-text-to-image";
const COMETAPI_VIDEO_MODEL = process.env.COMETAPI_VIDEO_MODEL || "grok-imagine-video-1-5-preview";

export const MODELS: ModelDef[] = [
  {
    canonical: "gpt-image-2-6/flare-text-to-image",
    aliases: ["gpt-image-2.6/flare-text-to-image", "flare-text-to-image"],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: { kie: KIE_IMAGE_MODEL, cometapi: COMETAPI_IMAGE_MODEL },
  },
  {
    canonical: "grok-imagine-video-1-5-preview",
    aliases: ["grok-imagine-video-1.5-preview"],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: { kie: KIE_VIDEO_MODEL, cometapi: COMETAPI_VIDEO_MODEL },
  },
];

export const MERGER_MODEL = "video-merger";

function dotNormalize(name: string): string {
  // gpt-image-2.6/... -> gpt-image-2-6/... ; grok-imagine-video-1.5-... -> -1-5-
  return name.toLowerCase().trim().replace(/(\d)\.(\d)/g, "$1-$2");
}

export function normalizeModel(name?: string | null): ModelDef | null {
  if (!name) return null;
  const raw = name.toLowerCase().trim();
  for (const m of MODELS) {
    if (m.canonical === raw || m.aliases.includes(raw)) return m;
  }
  const norm = dotNormalize(raw);
  for (const m of MODELS) {
    if (dotNormalize(m.canonical) === norm || m.aliases.some((a) => dotNormalize(a) === norm)) return m;
  }
  return null;
}

export function defaultModelFor(type: "image" | "video"): ModelDef {
  const m = MODELS.find((x) => x.type === type);
  if (!m) throw new Error(`لا يوجد نموذج افتراضي للنوع ${type}`);
  return m;
}

export function modelForCanonical(canonical: string): ModelDef | null {
  return MODELS.find((m) => m.canonical === canonical) || null;
}
