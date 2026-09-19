import { contentHash, stableJson } from "@basalt/contracts";
import { sealWorldChangeProposal, type WorldChange } from "./contracts.js";
import type { RefinementProposalProvider } from "./controller.js";

/** Try each authored alignment at most once. Geometry and acceptance remain with the controller. */
export function createRouteAlternativeProvider(): RefinementProposalProvider {
  const attempted = new Map<string, Set<string>>();
  let policyHash: string | undefined;
  return {
    async propose({ plan, worldBuild, observation, policy }) {
      if (policyHash !== undefined && policyHash !== policy.policyHash)
        throw new Error("Route alternative search cannot switch policies during a run");
      policyHash = policy.policyHash;
      const changes: WorldChange[] = [];
      for (const rule of policy.routeAlternatives) {
        if (
          !worldBuild.foundation.diagnostics.some((d) => d.startsWith(`route:${rule.routeId}:`)) &&
          !observation.checks.some((c) => c.subjectId === rule.routeId && c.status !== "eligible")
        )
          continue;
        const route = plan.routes.find((r) => r.routeId === rule.routeId);
        if (!route) throw new Error(`Route alternative target is absent: ${rule.routeId}`);
        const seen = attempted.get(rule.routeId) ?? new Set<string>();
        seen.add(stableJson(route.alignmentMeters));
        const next = rule.alternatives.find((a) => !seen.has(stableJson(a.alignmentMeters)));
        attempted.set(rule.routeId, seen);
        if (!next) continue;
        seen.add(stableJson(next.alignmentMeters));
        changes.push({
          kind: "route_alternative",
          routeId: rule.routeId,
          alternativeId: next.alternativeId,
        });
        if (changes.length === 32) break;
      }
      if (changes.length === 0) return undefined;
      return sealWorldChangeProposal({
        basePlanHash: plan.planHash,
        baseWorldBuildHash: worldBuild.worldBuildHash,
        changes,
        rationale:
          "Try unused authorized alignments for routes with compiler failures; preserve all geometric tolerances.",
        providerId: "BoundedRouteAlternatives",
        providerImplementationHash: contentHash(createRouteAlternativeProvider.toString()),
      });
    },
  };
}
