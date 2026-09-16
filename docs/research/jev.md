**Jev deserves a focused Basalt experiment. Its strongest potential is making the many small decisions inside planning and refinement fast and inexpensive. I would keep a capable reasoning model responsible for developing the world’s overall design.**

I checked TypeSafe’s documentation, SDKs, published evaluations, a separate hands-on evaluation, and Basalt’s current refinement implementation.

Jev accepts text or structured state and answers questions using three primitives:

| Primitive | What it returns                                   | Possible Basalt use                           |
| --------- | ------------------------------------------------- | --------------------------------------------- |
| `Choice`  | A supplied option and a probability distribution  | Choose a proposed route or construction edit  |
| `Score`   | A rating against supplied criteria                | Rank alternatives against the creator’s brief |
| `Noul`    | The estimated probability of a yes/no proposition | Flag a possible instruction violation         |

Questions are evaluated independently against shared state, in parallel. TypeSafe explicitly recommends narrow judgments rather than questions requiring extended reasoning. Jev does not generate descriptions, explanations, code, or arbitrary construction programs. [Introduction](https://docs.typesafe.ai/introduction), [System One documentation](https://docs.typesafe.ai/concepts/system-one).

That distinction matters: **a planning agent could use Jev extensively without Jev being the model that invents the plan.**

TypeSafe describes a new architecture, parallel sampling, and training called _Reinforcement Learning for Calibrated Decisions_. However, I found no reproducible technical paper or Jev weights in the public material I inspected. We can evaluate the exposed behavior; we cannot independently assess its internal architectural novelty yet. Access is through an early-access API, with public client SDKs. [Launch announcement](https://typesafe.ai/blog/introducing-system-one-models-and-jev), [SDKs](https://docs.typesafe.ai/sdk).

The speed and cost claims have some supporting evidence, with important limits:

- **TypeSafe advertises $0.042 per million input tokens, free output, and roughly 70–500 ms responses.** Its headline speedups concern selected workflows, and it acknowledges favorable conditions and comparison tradeoffs. Those numbers do not imply equivalent speedups for compiling a world. [Launch announcement](https://typesafe.ai/blog/introducing-system-one-models-and-jev).
- **A separate Every test found a meaningful tradeoff:** median latency of 0.35 seconds versus 8.83 seconds for a high-effort frontier comparator, but Jev caught six of seven deliberately introduced defects while the comparator caught all seven. Jev consistently missed the remaining defect. This is encouraging early evidence, from a very small test. [Every’s hands-on evaluation](https://every.to/also-true-for-humans/mini-vibe-check-typesafe-s-jev-judged-everything-i-ve-written-in-0-7-seconds).
- **The official workflow benchmark uses other models’ answers as its reference.** It measures agreement with their consensus, rather than independently established task correctness. We should apply the same discipline here that we applied to Basalt’s generated benchmark labels. [Evaluation methodology](https://evals.typesafe.ai/).

Its “zero hallucinations” claim also needs careful interpretation: the advertised zero concerns schema violations. A model can choose a valid option that is wrong. TypeSafe’s own documentation acknowledges that calibrated probabilities do not guarantee individual answers. [Launch explanation](https://typesafe.ai/blog/introducing-system-one-models-and-jev), [Calibration explanation](https://docs.typesafe.ai/concepts/system-one).

For Basalt, my assessment is:

| Responsibility                                                        | Jev’s potential fit                                         |
| --------------------------------------------------------------------- | ----------------------------------------------------------- |
| Turn an arbitrary prompt into an original world concept and hierarchy | Limited as the primary model; requires open-ended synthesis |
| Select among concrete region, route, or landmark proposals            | Promising                                                   |
| Prioritize issues and choose among bounded repairs                    | Strongest initial candidate                                 |
| Check many narrow semantic requirements repeatedly                    | Promising, subject to qualification                         |
| Judge rendered visual quality or identify modular pieces from images  | No documented image-input capability to rely on today       |
| Calculate clearance, validate access, or establish engine correctness | Keep these with deterministic checks and engine evidence    |

The documented input is text/JSON; the launch’s Doom demonstration also explicitly uses structured game state rather than images. Consequently, Jev could judge a supplied description of a scene, but that would inherit the description’s omissions and errors. It would not constitute another visual inspection. [API reference](https://docs.typesafe.ai/api), [Doom demonstration notes](https://typesafe.ai/blog/introducing-system-one-models-and-jev).

Consider our observation tower. A useful arrangement would be:

1. The reasoning planner establishes the design intent and proposes alternatives.
2. Basalt constructs bounded edit candidates and obtains their geometric consequences.
3. Jev ranks those candidates against narrow requirements: preserve the landmark’s prominence, minimize disruption to the approach, retain the intended reveal.
4. Basalt validates the selected edit, recompiles affected tasks, and gathers new observations.
5. Cases requiring a new design or missing evidence return to the reasoning planner.

**Those alternatives can be generated dynamically.** We do not need a fixed global list of every possible building or world style. Jev’s choices can reference the specific proposals available in the current situation. Its documented `Choice` limit is 255 options, with explicit “none of these” options recommended where coverage is incomplete. [Choice documentation](https://docs.typesafe.ai/primitives/choice).

There is one subtle architectural constraint: independently answered questions do not establish joint feasibility. Selecting a taller tower and a shorter staircase separately could produce an incompatible combination. For coupled changes, present coherent edit bundles or make sequential decisions using updated state. The compiler must still check the result.

Basalt already has a useful integration boundary: [`RefinementProposalProvider`](/Users/mawawdi/Desktop/basalt/packages/world-refinement/src/controller.ts:27). Its proposals can change whitelisted construction parameters or choose route alternatives. A small adapter could convert Jev’s selected candidate into the existing proposal format; Jev would not need to author arbitrary JSON or geometry.

I also found an important current limitation: **the refinement loop runs while geometric status is `incomplete`.** It does not continue simply because a geometrically valid world looks unappealing or has weak experiential design. Visual assessment is stored separately. Adding Jev would not, by itself, supply that missing quality objective or feedback loop. [Controller condition](/Users/mawawdi/Desktop/basalt/packages/world-refinement/src/controller.ts:93), [Observation contract](/Users/mawawdi/Desktop/basalt/packages/world-refinement/src/contracts.ts:116).

My recommended next step is **one bounded selection experiment**, without changing the catalog architecture:

1. Assemble a small development set of real route/tower edit decisions, including several acceptable alternatives, no acceptable alternative, and insufficient evidence.
2. Compare a simple rule baseline, our reasoning-model baseline, and Jev on identical state and candidates.
3. Measure the resulting edit’s success, instruction preservation, mistaken acceptance, abstention, latency, and total cost—not merely agreement with generated labels.
4. Test on separate layouts before allowing autonomous selections. Preserve exact requests and responses for replay.

TypeSafe supplies an [open-source comparison adapter](https://github.com/typesafe-ai/system-one-adapter-python), so we can reuse its evaluation interface rather than inventing another framework.

Finally, its confidence field is a statistic derived from its probability distribution. Training those probabilities for calibration is a worthwhile distinction from our old SigLIP formulation, but thresholds still need validation on Basalt’s decisions. [Confidence documentation](https://docs.typesafe.ai/confidence).

The opportunity I would pursue is **more frequent, inexpensive checks and better selection among candidate improvements**. That could materially improve Basalt’s refinement economics while preserving the planner’s creative freedom and the compiler’s spatial guarantees.
