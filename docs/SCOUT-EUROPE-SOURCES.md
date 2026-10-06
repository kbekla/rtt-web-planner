# Scout Europe source intake

`config/scout/europe-source-catalog.json` is the private engineering catalogue seeded from Karl's Europe source master list, with Turkey's KGM source lead added from the follow-up. It currently contains 45 source leads across 41 ISO country codes and 43 modeled jurisdiction IDs (regional splits account for the difference). It is a planning registry, not an approval list, live crawler configuration, or assertion that Europe-wide coverage is complete. The coverage matrix is available as `npm run scout:geo -- europe matrix`; JSON source details are available through `npm run scout:geo -- europe sources [--country-code CC]`.

## Scope

- England (`GB-ENG`), Wales (`GB-WLS`) and the Isle of Man (`IM`) are explicitly excluded.
- Scotland (`GB-SCT`) is an independent Scout jurisdiction entry. Its authoritative sources and verification model still need their own source-level research.
- Belgium Flanders and Wallonia are separate entries. Bosnia and Herzegovina's Federation and Republika Srpska are separate research scopes.
- The current leads do not yet cover Andorra, Armenia, Azerbaijan, Belarus, Kazakhstan, Monaco, Russia, San Marino or Vatican City. There are also no source leads for Northern Ireland (not explicitly excluded), the Faroe Islands, Åland, Gibraltar, Guernsey or Jersey. Turkey is included as a transcontinental jurisdiction through the KGM lead. Geographic Europe/transcontinental boundaries vary; these are explicit coverage gaps, not an assertion that every source in a state already covers them.

## Safety state

Every entry is a `REVIEW_REQUIRED` lead. The loader in `scripts/scout/europe-source-catalog.mjs` overlays `automation_enabled:false`, `reuse_verified:false`, and denied private-processing, redistribution, derived-public-use and legal-evidence permissions. It rejects activation fields or download URLs in this unverified catalogue. No source endpoint is fetched by loading or listing the catalogue.

Portal, dataset, access-method and licence notes preserve what was supplied for research. A reported open licence is not yet a source approval. Before a source is activated, verify the exact current dataset and authority, endpoint and permitted machine access, jurisdiction/coverage, licence/version, attribution, commercial and derivative-use terms, update semantics, checksum/versioning, and the claim types the dataset can support. A network map can support physical/network context; it cannot establish motorcycle access merely by containing a road. Restriction sources require explicit vehicle applicability, dates, geometry identity and authority gates.

## Authority overclaims to avoid

- A road register, national road network, transport graph, topographic database, cadastre, or route geometry does not by itself establish motorcycle permission. This applies even when the dataset is official and includes ownership, surface, public/private labels, passability, or traffic-rule attributes; each field's legal meaning and vehicle applicability must be verified.
- Norway/Sweden/Finland entries mention restrictions, ownership or traffic rules, but none is currently qualified as motorcycle-access evidence. Estonia's Road Register is a strong lead for status/restriction research, not a blanket country-wide motorcycle permission oracle.
- Iceland's F-road class and live road-condition/closure feeds describe network/condition state; a road class or an open road-condition indicator is not by itself legal permission to ride.
- Turkey's KGM is a strong official starting point for national/state/provincial road-network, restriction/closure and road-condition research. The lead is not a verified, complete country-wide trail inventory; forest, village and off-road coverage needs secondary authoritative sources. Access rights, exact products, machine interfaces and licences remain unaudited, so every KGM role is potential-only and disabled.
- France's BD TOPO, Spain's caminos/sendas, Germany's Basis-DLM passability, Swiss road/hiking geometry, and comparable topographic/network layers support physical/network discovery only until access rules are separately established.
- Portugal SNIG, Italy RNDT, Bulgaria INSPIRE, and several broad national geoportals are catalogues/portals rather than one approved dataset. A catalogue record does not grant access or reuse rights to a listed service.
- A graph/road layer is only potential routing geometry. Routing eligibility also needs a licensed graph, profile-compatible attributes, connected topology, tested route behavior, and an independent access decision.
- The supplied licence statements (including Open Licence 2.0, CC BY 4.0, CC0, ODbL/open-data notes) are retained as reported claims unless the exact current official dataset terms have been verified. They are not a permission grant in this registry.

## Operator interface and next stages

The catalogue API is deliberately read-only:

```js
import { listEuropeSourceCandidates } from '../scripts/scout/europe-source-catalog.mjs';
listEuropeSourceCandidates({ countryCode: 'BE' });
```

CLI matrix and lead listing do not access the network or private geostore and do not make sources active.

Next, audit source leads country by country, then register only exact verified datasets in Scout's existing private source registry. Implement provider-specific adapters behind the existing pinned, checksum-aware, resumable job pipeline. Regional jobs must continue to use shared factory admission; ordinary road-network discovery and authoritative legal/status monitoring remain distinct evidence roles. No whole-Europe bulk acquisition should be attempted as one job.

All source-to-corridor cross-references remain private on the SSD. Public map output can contain only permitted route/status material and general dataset acknowledgements required by licence; Scout discovery provenance is never attached to an individual lane. A separately licensed partner layer is handled independently and only under explicit display permissions. No entries in this catalogue have been downloaded or processed, no second country has been run, and no public output or canonical data has changed.
