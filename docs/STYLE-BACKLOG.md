# RT&T style backlog

These are open style issues found in the Phase 2 visual review on 2026-10-02 (build `uk`, 10 views in `config/regions/uk.yaml`). All of them are style or scaffold issues: the tiles already carry the data. They wait for the RT&T style work and are deliberately **not** fixed piecemeal in the vendored OSM Bright scaffold.

When an item is fixed:
- Fix it in `styles/rtt/` (overlay or the RT&T style), never in `styles/vendor/`.
- Re-accept the affected goldens with `make goldens` after reviewing them.
- Mark the item done here, with the commit.

| ID | Issue | Evidence | Direction | Status |
|---|---|---|---|---|
| S1 | **Mountain peaks are never drawn.** The scaffold has no `mountain_peak` layer. | `uk-snowdon`, `uk-lake-district`. The tiles contain Yr Wyddfa (1085 m) and Scafell Pike (978 m); probes `snowdon-summit` and `scafell-pike` check this. | Add a peak symbol and a name + `ele` label, with rank-based min zoom. Include `class=volcano`/`saddle` handling. | Open |
| S2 | **Footpaths are very faint.** `highway-path` is a thin, light dash, and path names only appear from z15.5. | `uk-snowdon`, `uk-lake-district` | Make trails first-class: stronger casing and contrast, show them from z12–13, name them earlier, and distinguish `path`/`track`/`steps`. This matters most for the product. | Open |
| S3 | **Unstyled landuse classes.** Only residential, commercial, industrial, cemetery, hospital, school and railway have fills. | `uk-edinburgh`, `uk-belfast`. `landuse.class` is an open set (see `schema/openmaptiles-3.16.0.overrides.json`). | Style the common open-set classes (`education`, `university`, `college`, `park`, `religious`, `recreation_ground`, `healthcare`, …) and give unknown classes a neutral fallback. | Open |
| S4 | **Admin boundaries are drawn along the coast.** County and unitary boundaries follow the low-water line and aren't tagged `maritime`, so a heavy dashed line traces the coast and out across mudflats. | `uk-thames-estuary`, `uk-lands-end`, `uk-edinburgh` | Lighten boundaries at admin levels 5–8. Consider hiding them over water, or drawing them under the water layer. | Open |
| S5 | **Areas outside the extract are blank land.** The Republic of Ireland and the Isle of Man render as empty land at low zoom. | `uk-overview` | This is expected for a UK-only extract. Decide on product behaviour: a neutral "outside coverage" treatment, or Natural Earth context at low zoom. | Open |
| S6 | **Generic POI icons.** POIs without a class-specific icon show as black dots (`circle_11` fallback from `styles/rtt/overlay.json`). | `uk-london-overzoom` | Add an RT&T icon set covering the common UK POI classes, plus a subtler fallback. | Open |
