# Region Authoring Performance Record

This is the single interpretation record for prompt-region runtime, model usage, retries,
cache conditions, and cost. These measurements are operational evidence. They are not quality
thresholds and do not authorize compiler eligibility, visual acceptance, or engine verification.
Implemented behavior belongs to `docs/ARCHITECTURE.md`; active work belongs to `TASKS.md`.

## Recording contract

Every run retains its exact request, execution policy, proposal and review requests, raw provider
responses, usage, failures, captures, and report below its absent-at-start output directory. New
receipts record the selected OpenRouter model, the upstream provider when OpenRouter reports it,
transport configuration, token usage, reported cost, duration, and failure text. A missing upstream
provider is recorded as unavailable rather than inferred. Cache state comes only from provider usage
fields. Operational timeout or allocation exhaustion produces `incomplete` evidence; elapsed time is
never an acceptance condition.

## Retained habitat-coverage experiment

The September 2026 `wooded-refuge` development case used OpenRouter with
`deepseek/deepseek-v4.1-flash`, low reasoning, throughput routing, and a 24,576-token combined
reasoning/output allowance. The historical receipts did not expose the upstream provider. The
generation prompt requested a 112-meter wooded refuge; its accepted development candidate contained
2,788 instances and three captured cameras. The edit requested denser northern woodland and a wider
campsite clearing while preserving paths and props.

| Phase    |  Duration | Calls | Prompt / completion / total tokens | Reported cost | Retries and cache                                                                                             | Outcome                                                                           |
| -------- | --------: | ----: | ---------------------------------: | ------------: | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Generate | 288.718 s |     4 |          85,925 / 43,191 / 129,116 |   $0.07428894 | One scene repair after a malformed first review; 12,288 cached prompt tokens on the second proposal           | Compiler eligible and same-model visually eligible; independent acceptance absent |
| Edit     | 179.054 s |     4 |         112,505 / 15,649 / 128,154 |   $0.04810662 | Two rejected proposals, then one ineffective realized edit; 16,384 cached prompt tokens on the third proposal | Incomplete because the density objective had no realized effect                   |
| Combined | 467.772 s |     8 |         198,430 / 58,840 / 257,270 |   $0.12239556 | Three proposal retries across both phases                                                                     | Development evidence only                                                         |

The retained reports are
`.basalt/evals/prompt-region/habitat-coverage/wooded-refuge/generated/report.json` (SHA-256
`008f75070dc4bc95e1809669c93f868b83b89857c39e85e9ce35721f3ad97c24`) and
`.basalt/evals/prompt-region/habitat-coverage/wooded-refuge/edited/report.json` (SHA-256
`78e72e329c8edd6974a4920a711898c87b54f0387ba5fa84370f57c80b7d1b6a`). Their call receipts remain
under each phase's `attempts/` directory. The generation receipt hashes are
`f87b896145194e3f2126d5815b3069cc36f692336234671c22b4e33e861ca692`,
`d8027431fa50dc7d7d045171146b997a338b208fb15764ac03c8925a58a121d2`,
`5a85887b27762c795d19885804d8f05b42a80f6fc6747f4498a94c8bb16a53fc`, and
`5e4d3544b82d3f9e74207c7cf5eccc651643e3e695266c8976cca94c5aae2cef`. The edit receipt hashes are
`891a629c671c69e02bee0869ba46d3c37f506e66fc66c192a302a366dafa93c4`,
`5b01b71ece419c94e0ff0715eaa248d09ea5953914051f4dc88c21107caf204d`,
`e21d77edaa90bd5e0826571d41ac5fd00019ade37b42752de0b6fac21bd1a5bf`, and
`f0e3ee16507ea3873f2b46e2da10fa025263415c3afaaa462bfb7b084c750740`.

The experiment identifies two separate costs: model latency dominated wall time, while an edit could
consume nearly the same tokens as generation and still make no useful spatial change. The current
workflow therefore verifies every edit objective against realized placements and retries malformed
review JSON against the same geometry. Fresh runs are compared by workload and cache conditions,
not by a universal deadline.

## Capacity-cutover qualification runs

The cutover evaluated three declared briefs and two fresh briefs. Every generation seed came from
the fixture and every edit inherited its base seed. These rows include all linked extraction,
planning, review and synthesis calls in each report. Cached tokens are provider-reported prompt
tokens; zero means the provider reported no cache hit rather than that Basalt disabled caching.

| Workload and phase             |  Seed | Instances / models |  Duration | Calls | Prompt / completion / total tokens |    Cached | Reported cost | Transport/retry condition and outcome                                                 |
| ------------------------------ | ----: | -----------------: | --------: | ----: | ---------------------------------: | --------: | ------------: | ------------------------------------------------------------------------------------- |
| Wooded refuge, generate        | 11001 |           708 / 28 | 254.689 s |     6 |         541,670 / 49,074 / 590,744 |   120,960 |   $0.18582756 | Two semantic attempts; no transport failures; compiler and same-model review eligible |
| Wooded refuge, compound edit   | 11001 |           813 / 28 | 153.766 s |     7 |     1,084,815 / 16,465 / 1,101,280 |   636,416 |  $0.158096196 | No transport failures; every edit objective and same-model review eligible            |
| Orchard court, generate        | 11002 |           473 / 33 | 194.048 s |     4 |         461,989 / 34,539 / 496,528 |    31,104 |  $0.170898924 | One semantic attempt; no transport failures; compiler and same-model review eligible  |
| Orchard court, compound edit   | 11002 |           512 / 33 | 262.355 s |    11 |     1,689,120 / 32,207 / 1,721,327 | 1,232,000 |  $0.183176400 | Linked review/extraction calls; no transport failures; objectives and review eligible |
| Woodland rest, generate        | 11003 |         1,930 / 30 | 234.111 s |     5 |         386,511 / 42,480 / 428,991 |   138,240 |   $0.12628674 | One semantic attempt; no transport failures; compiler and same-model review eligible  |
| Woodland rest, compound edit   | 11003 |         1,872 / 30 | 200.210 s |     8 |         699,267 / 21,063 / 720,330 |   444,928 |  $0.104246868 | No transport failures; objectives and same-model review eligible                      |
| Market grove, fresh generate   | 12001 |           368 / 35 | 154.794 s |     5 |         546,442 / 27,395 / 573,837 |   191,616 |  $0.140471496 | One semantic attempt; no transport failures; compiler and same-model review eligible  |
| Market grove, fresh edit       | 12001 |           397 / 35 | 417.346 s |    10 |     1,364,106 / 55,422 / 1,419,528 |   989,696 |  $0.184767576 | No transport failures; objectives and same-model review eligible                      |
| Arch and swing, fresh generate | 12002 |           417 / 30 | 149.016 s |     4 |         424,722 / 27,478 / 452,200 |    32,256 |  $0.150906936 | One semantic attempt; no transport failures; compiler and same-model review eligible  |
| Arch and swing, fresh edit     | 12002 |           446 / 30 | 152.554 s |     8 |     1,134,735 / 16,791 / 1,151,526 |   736,768 |  $0.143959908 | No transport failures; objectives and same-model review eligible                      |

The raw reports and call receipts remain under these roots:

- `.basalt/evals/prompt-region/capacity-cutover-final-seeded/wooded-refuge/`: generation report
  `8f96b0d493467adc6a65d8db862a8732e1425836de208905a4ecb7bd72dcbd6d`, edit report
  `e85d72dc7b7a2e9fad5b63bb14eb768b93a79c011456e8d3ce264f5e15054ec6`.
- `.basalt/evals/prompt-region/capacity-cutover-qualified-seeded/orchard-court/`: generation
  `b31fc4d05fb67cb533aa5dca8047feca777778bd0baedad815e643cc105aed5d`, edit
  `a8b0d3d98db81083eb350b52b2a70caaf3c536b822bc2078bdd831ac180e5394`.
- `.basalt/evals/prompt-region/capacity-cutover-final-seeded/woodland-rest/`: generation
  `942abc1e83004ddebb6328d3b10623ea400892e5942b1ed1dab56c9fa8c5bbde`, edit
  `7a0956ae16096a0a5b0e8e588440d5e61de5cd9cbd402426ac1ea0ad33b783e3`.
- `.basalt/evals/prompt-region/capacity-cutover-fresh-final-seeded/market-grove-trailhead/`:
  generation `9e57f248c4f4bbf528b98529f8bf8b83799d37491379d31225c130e7e5e57845`, edit
  `165e4f3a0db1e1c065e7eda2be0fc3c1ae68f4c1238fcb55d08b41f56fcdc97b`.
- `.basalt/evals/prompt-region/capacity-cutover-fresh-final-seeded/arch-and-swing-circuit/`:
  generation `340293a80e355492006cdc36f6a69df86cb8a4e4424d5d6570973edb2c121cf4`, edit
  `61f83ed785af9e532af99127dd8097d6691f0f0ee5fc3e495f1aaa675314308f`.

The five generations and five edits establish compiler and same-model development behavior. They do
not establish independent visual quality. The independent delegated-AI review at
`.basalt/evals/prompt-region/independent-review/capacity-cutover.json` judged all five generation
compositions `incomplete`, with specific weaknesses in route contact, prop grouping, ground-patch
shape, open-space composition and camera occlusion.

## Current-source compact-evidence run

After exact route tessellation was moved out of model context and replaced by a hash, complete
bounds, segment count, grade summary and local evidence pointer, the current-source wooded-refuge
generation used 142,980 prompt tokens across all five calls rather than the 386,511–546,442 prompt
tokens seen in the earlier declared generations. This is not a controlled provider A/B comparison,
but it confirms that complete local evidence does not require serializing every route vertex into
every review request.

| Phase    | Instances / models |  Duration | Calls | Prompt / completion / total tokens | Cached | Reported cost | Provider and outcome                                                                              |
| -------- | -----------------: | --------: | ----: | ---------------------------------: | -----: | ------------: | ------------------------------------------------------------------------------------------------- |
| Generate |           761 / 31 | 446.787 s |     5 |         142,980 / 37,223 / 180,203 | 89,344 | $0.0329827448 | DeepInfra and Together; one retained transport failure; compiler and same-model review eligible   |
| Edit     |                  — | 156.642 s |     3 |             8,948 / 3,007 / 11,955 |      0 |   $0.00395318 | Extraction succeeded on Fireworks; proposal stopped before geometry on provider credit exhaustion |

The reports are
`.basalt/evals/prompt-region/capacity-cutover-final-compact/wooded-refuge/generated/report.json`
(`1ead405c1ac6f58405db8356ddb4fdd1fe0a2c12f5b8e795e8ebd233af3482f9`) and
`.basalt/evals/prompt-region/capacity-cutover-final-compact/wooded-refuge/edited/report.json`
(`3be176590500bc1777da5c400fab300cd6703ad2b64d2b9cc571f5a0b2c9fa72`). The edit asked for
16,000 proposal output tokens; OpenRouter reported that the remaining account credit could afford
11,822. That retained run predates structured exhaustion handling and repeated the unchanged request
once. The current runtime records the provider resource, requested and available output-token values,
origin and reason, then stops immediately with resumable `incomplete` evidence. Reducing logical edit
scope or silently lowering the allocation is not a valid repair for account-credit exhaustion.

## Organic-paint cutover probe

The September 20, 2026 current-source probe attempted the same seeded `wooded-refuge` generation
after terrain paint gained explicit hard and organic edge profiles. OpenRouter rejected the first
layout request during preauthorization: the declared layout allocation was 28,000 output tokens and
the account could fund 11,822. No model output, geometry, preview, token usage, or cost was produced.
The run stopped after 0.431 seconds as resumable `incomplete` evidence; it does not visually qualify
the new boundary behavior. The production allocation was not silently reduced because retained
layout completions for this workload range above and below the available amount.

The report remains at
`.basalt/evals/prompt-region/organic-paint-cutover/wooded-refuge/generated/report.json` (SHA-256
`ed6d857c302d265591d4ebbf8059057fe3ea58b1e131c5b6a7122ae307c0fab7`). The bound failure and event
artifacts are under `attempts/1/`; their hashes are
`b9cf69f13925d2188bf1bbcdfa0bc0f1e2fd4aa2215a3ed9ddd06ad43229ee5f` and
`7ab9ad793c44086975823e653d0520baa034dcd233ab0bd9e55b3d7355cbcd02`.
