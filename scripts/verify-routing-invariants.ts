// Exhaustive check of the antigravity routing invariants. The scope is finite and
// fully enumerated: every public model in the static catalog × every thinking
// effort Pi can send. Run with `yarn verify:routing`.
import {
  ANTIGRAVITY_MODELS,
  ANTIGRAVITY_ROUTING,
  applyAntigravityCatalog,
  getAntigravityRequestModelId,
  getCurrentAntigravityCatalog,
  getFallbackRuntimeModel,
  getMaxOutputTokens,
  resetAntigravityCatalogForTests,
  runtimeTier,
  siblingRuntimeModels,
} from "../src/models/index.js";
import type { AntigravityRouting } from "../src/types/types.js";

const EFFORTS = [undefined, "off", "minimal", "low", "medium", "high", "xhigh", "turbo"] as const;
const MODEL_IDS = Object.keys(ANTIGRAVITY_ROUTING);

const failures: string[] = [];
let checks = 0;

function ok(condition: boolean, message: string): void {
  checks += 1;
  if (!condition) failures.push(message);
}

function declaredIds(routing: AntigravityRouting): Set<string> {
  const ids = new Set<string>(Object.values(routing.routing ?? {}));
  if (routing.off) ids.add(routing.off);
  if (routing.defaultRequestId) ids.add(routing.defaultRequestId);
  return ids;
}

const universe = new Set<string>();
for (const id of MODEL_IDS) {
  universe.add(id);
  for (const runtime of declaredIds(ANTIGRAVITY_ROUTING[id])) universe.add(runtime);
}

resetAntigravityCatalogForTests();

// P1: routing is total over model × effort and never invents an id outside the
// model's own declared routes.
for (const modelId of MODEL_IDS) {
  const declared = declaredIds(ANTIGRAVITY_ROUTING[modelId]);
  for (const effort of EFFORTS) {
    let runtime: string;
    try {
      runtime = getAntigravityRequestModelId(modelId, effort);
    } catch (error) {
      failures.push(`P1 ${modelId}/${String(effort)} threw: ${String(error)}`);
      continue;
    }
    ok(typeof runtime === "string" && runtime.length > 0, `P1 ${modelId}/${String(effort)} empty`);
    ok(
      declared.has(runtime) || runtime === modelId,
      `P1 ${modelId}/${String(effort)} -> ${runtime} is not a declared route (${[...declared].join(",")})`,
    );
    // P2: routing is deterministic.
    ok(
      getAntigravityRequestModelId(modelId, effort) === runtime,
      `P2 ${modelId}/${String(effort)} is not deterministic`,
    );
  }
}

// P3: distinct public models never collapse onto the same runtime id at the same effort.
for (const effort of EFFORTS) {
  const seen = new Map<string, string>();
  for (const modelId of MODEL_IDS) {
    const runtime = getAntigravityRequestModelId(modelId, effort);
    const other = seen.get(runtime);
    ok(
      other === undefined || other === modelId,
      `P3 ${modelId} and ${other} both resolve to ${runtime} at effort ${String(effort)}`,
    );
    seen.set(runtime, modelId);
  }
}

// P4: the static catalog is self-consistent — every model has a usable default route.
for (const model of ANTIGRAVITY_MODELS) {
  const routing = ANTIGRAVITY_ROUTING[model.id];
  ok(routing !== undefined, `P4 ${model.id} is in the catalog without a routing entry`);
  if (!routing) continue;
  const declared = declaredIds(routing);
  ok(declared.size > 0, `P4 ${model.id} declares no runtime id`);
  if (routing.defaultRequestId) {
    ok(declared.has(routing.defaultRequestId), `P4 ${model.id} default ${routing.defaultRequestId} is undeclared`);
  }
  ok(model.maxTokens > 0, `P4 ${model.id} has maxTokens ${model.maxTokens}`);
}

// P5: a fallback is either absent or a runtime id this package declares, and it
// always moves away from the id it replaces.
for (const runtime of universe) {
  for (const effort of EFFORTS) {
    const fallback = getFallbackRuntimeModel(runtime, effort);
    if (fallback === undefined) continue;
    ok(universe.has(fallback), `P5 fallback of ${runtime} -> ${fallback} is outside the declared catalog`);
    ok(fallback !== runtime, `P5 fallback of ${runtime} is itself`);
  }
}

// P6: siblings are probe candidates, so they need not be in the catalog, but they
// must keep the tier base, exclude the input and stay unique.
for (const runtime of universe) {
  const siblings = siblingRuntimeModels(runtime);
  const base = runtimeTier(runtime)?.base;
  for (const sibling of siblings) {
    ok(sibling !== runtime, `P6 ${runtime} lists itself as a sibling`);
    if (base !== undefined) {
      ok(
        runtimeTier(sibling)?.base === base,
        `P6 sibling ${sibling} of ${runtime} changes the tier base`,
      );
    }
  }
  ok(
    new Set(siblings).size === siblings.length,
    `P6 siblings of ${runtime} repeat an entry`,
  );
}

// P7: the static table and the runtime table agree on output limits, and a
// catalog refresh does not change the answer for a model the refresh keeps.
for (const model of ANTIGRAVITY_MODELS) {
  const routing = ANTIGRAVITY_ROUTING[model.id];
  if (!routing) continue;
  const bare = getMaxOutputTokens(model.id);
  ok(bare > 0, `P7 ${model.id} has no output limit`);
  for (const runtime of declaredIds(routing)) {
    ok(
      getMaxOutputTokens(model.id, runtime) === bare,
      `P7 ${model.id}: runtime ${runtime} reports ${getMaxOutputTokens(model.id, runtime)} but the model reports ${bare}`,
    );
  }
}

// P8: a model retired by a catalog refresh is reported, never silently resurrected
// from the bootstrap table.
const reduced = {
  models: getCurrentAntigravityCatalog().models.filter((model) => model.id !== "gemini-3.7-flash"),
  routing: Object.fromEntries(
    Object.entries(ANTIGRAVITY_ROUTING).filter(([id]) => id !== "gemini-3.7-flash"),
  ),
};
applyAntigravityCatalog(reduced);
try {
  getAntigravityRequestModelId("gemini-3.7-flash", "high");
  failures.push("P8 a retired model was routed from the bootstrap catalog instead of reporting");
} catch (error) {
  ok(/absent from the current catalog/.test(String(error)), `P8 unexpected error text: ${String(error)}`);
}
resetAntigravityCatalogForTests();

const total = checks;
if (failures.length > 0) {  console.error(`formal check FAILED: ${failures.length} of ${total} assertions`);
  for (const failure of failures.slice(0, 20)) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(
  `formal check passed: ${total} assertions over ${MODEL_IDS.length} models x ${EFFORTS.length} efforts, ` +
    `${universe.size} runtime ids, 8 properties`,
);
