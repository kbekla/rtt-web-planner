# Scout rider-facing route status

Scout keeps its private claim-level evidence graph. The product status is a deterministic projection in `scripts/scout/product-model.mjs`; it does not replace physical existence, motorcycle access, routability, source lineage, restrictions, or review history. RT&T is a navigation and discovery application, not an authority granting access.

## Status and route behavior

- Ordinary recognized roads remain ordinary roads and do not become Scout GREEN/ORANGE lanes. Applicable restrictions may overlay them.
- GREEN means the lane is verified under the applicable jurisdiction policy or has current qualified access evidence. It is not a legal guarantee. Automatic routing may use GREEN only when connected routable geometry is also verified.
- ORANGE means credible physical-lane evidence exists but access has not been verified. Missing legal data is not a prohibition. ORANGE is visible and can be deliberately selected, created into a route, or included in an imported route when usable geometry exists. Automatic routing does not select it.
- RED requires positive motorcycle/motor-vehicle prohibition evidence. It is blocked from automatic, manual, created, and imported navigation.
- TEMPORARILY_CLOSED overlays the underlying state only while an applicable dated restriction is active. The underlying GREEN/ORANGE evidence is retained; expiry/revocation permits re-evaluation. A permanent prohibition remains RED when both kinds of restriction are present.

A jurisdiction must explicitly provide its verification model. The default is conservative: no jurisdiction policy and no qualified permission means ORANGE for credible lanes. `OPEN_UNLESS_RESTRICTED` is supported only when the route is independently recognized as public and the current restriction check is complete. UK-specific status requirements are not applied globally. Routability remains an independent graph check; the product model does not alter the live Valhalla graph.

## Research and escalation

`SCOUT_RESEARCH_REQUIRED` means Scout should continue deterministic research or wait for more evidence; it does not ask Karl to decide foreign access law. Normal unresolved lanes settle as ORANGE and do not by themselves trigger AMBER email. `AUTO_RESOLVED` includes an acceptable ORANGE result where current approved research is exhausted. `HUMAN_ESCALATION` is reserved for a source permission/licence decision, an authoritative conflict, an actionable geometry identity ambiguity, or an integrity/business exception. `QA_SAMPLE` is sampling, not a route approval.

The historical corridor queue values remain intact for audit. In particular, `UNREVIEWED` records with TET hint support are projected as `SCOUT_RESEARCH_REQUIRED`; they are not rewritten to imply human legal review. Public output does not include TET, community, rider or other private discovery provenance. The required public data attribution remains in map credits. A public authority may be named only when its record directly supports the displayed restriction/status. The canonical PMTiles field whitelist remains unchanged.

## Current Belgium projection

The current Belgium corridor evidence has 247,662 topology-backed corridors: 135,025 probable off-road character, 40,115 unsealed-road character and 72,522 unknown physical character. Motorcycle access remains unknown for all, routability remains unknown, and there are no ingested authoritative Belgian restriction records in the registered real run. The deterministic product projection is therefore 247,662 ORANGE, zero GREEN, zero RED, zero active temporary closures, and zero ordinary roads in this OSM *candidate corridor* set. Ordinary roads are excluded from that discovery set and remain ordinary network roads. The 150 TET-supported entries project to Scout research required; none requires Karl to adjudicate legal access. No classification or review decision in the saved Belgium database was changed for this projection.

These counts describe current available evidence, not a legal finding that the routes are open. Existing TET provenance remains private. Belgium still needs approved, ingested access/restriction sources before lanes can move to GREEN or RED based on those sources.
