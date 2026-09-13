import { deepFreezeJson } from "@basalt/contracts";
import { sealNeuralProviderDeclaration, type NeuralProviderId } from "./execution.js";

/**
 * Restored provider routes. Their status is intentionally incomplete until a
 * qualification is issued against the rewritten worker bytes and retained
 * rights/runtime evidence. Declaring a provider never authorizes a paid run.
 */
export const RESTORED_NEURAL_PROVIDERS = deepFreezeJson([
  sealNeuralProviderDeclaration({
    providerId: "trellis2",
    modelId: "microsoft/TRELLIS.2-4B",
    sourceCommitHash: "75fbf0183001ed9876c8dbb35de6b68552ee08bd",
    modelRevisionHash: "af44b45f2e35a493886929c6d786e563ec68364d",
    capabilities: ["image_to_3d"],
    minimumGpuMemoryMiB: 40 * 1024,
    usageScope: "research",
    status: "incomplete",
    diagnostics: [
      "A qualification must bind the restored worker implementation and current runtime evidence",
      "Product use still requires retained commercial-rights and creator-run engine evidence",
    ],
  }),
  sealNeuralProviderDeclaration({
    providerId: "hunyuan3d_2_1",
    modelId: "tencent/Hunyuan3D-2.1",
    sourceCommitHash: "82920d643c0dc2f7bfd7255f45f62d386edfe60c",
    modelRevisionHash: "0b94677654c57bb9a6b6845cd7b704ccf551d327",
    capabilities: ["image_to_3d"],
    usageScope: "research",
    status: "incomplete",
    diagnostics: [
      "The restored route is a research probe and does not yet contain qualified inference",
      "Commercial catalog admission is blocked by the retained provider-rights policy",
    ],
  }),
  sealNeuralProviderDeclaration({
    providerId: "pixal3d",
    modelId: "TencentARC/Pixal3D",
    sourceCommitHash: "f7cf38429b0bd264f1995f0f8743a88b1c728b94",
    modelRevisionHash: "b0cb2e1b794cab9aa0ac38a95d794a4d9337437f",
    capabilities: ["image_to_3d"],
    usageScope: "research",
    status: "incomplete",
    diagnostics: [
      "The restored route is a qualification scaffold and does not yet contain inference",
      "Runtime, dependency, and commercial-rights evidence remain incomplete",
    ],
  }),
]);

/** Operational locators are deliberately outside provider identity hashes. */
export const NEURAL_PROVIDER_WORKERS = Object.freeze({
  trellis2: "workers/trellis2/worker.py",
  hunyuan3d_2_1: "workers/hunyuan3d/worker.py",
  pixal3d: "workers/pixal3d/worker.py",
} satisfies Record<NeuralProviderId, string>);
