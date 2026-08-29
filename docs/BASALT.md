# Basalt product principles

Basalt compiles a creator's map brief into a large, coherent Roblox world.
It is a hierarchical world compiler, not a general game-development agent.

The compiler works at three spatial scales:

1. **Macro:** continuous terrain fields, water, biome masks, routes, partitions,
   and regional topology.
2. **Meso:** modular structures, cliffs, surfaces, socketed assemblies, and
   coherent asset families.
3. **Micro:** deterministic surface-aware population, variation, materials,
   foliage, decals, and effects.

Art direction is independently hierarchical: global world style, biome or
seasonal overlay, asset family, then archetype/instance. Overlays retain the
same terrain-field hash and change only surface realization and atmosphere.

The creator supplies intent and references. The model proposes open-vocabulary
style, regional composition, family plans, and revisions. Basalt's typed workers
own physical geometry, surface sampling, relation solving, asset adaptation,
partitioning, provenance, and transaction boundaries.

Basalt does not generate one unrelated mesh for every visible object. It resolves
families through one indexed registry lookup per regional request, adapts a small
number of archetypes, and reuses them through immutable population artifacts.
Neural generation is an offline family-factory route: it
can create distinctive family members and hero exceptions, but it never blocks
terrain, routes, blockout, or deterministic population.
One-shot neural geometry is limited to sub-8-stud `focal_insert` requirements;
large landmarks are assembled from typed procedural shells and socketed parts.

Basalt keeps creator claims separate from model hypotheses and evidence. A render
or generated image can guide composition; it cannot become geometry authority.
No candidate is accepted without structural adaptation, bounds/support checks,
style compatibility, and exact provenance.

The Roblox connector remains a transaction boundary. It receives partitioned,
canonical world plans and applies bounded deltas with ChangeHistory, detached
preflight, readback, and reconciliation. Basalt never launches Studio; the
creator performs import, save/reopen, and final visual checks.

Gameplay scripts are external inputs. Basalt may expose named spatial anchors,
routes, sockets, and bindings for another system, but it does not own a gameplay
runtime, gameplay AST, network remotes, state machines, or task libraries.
