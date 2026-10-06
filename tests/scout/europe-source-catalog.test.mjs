import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyEuropeSourceRoles, listEuropeSourceCandidates, loadEuropeSourceCatalog, renderEuropeCoverageMatrix, validateEuropeSourceCatalog } from '../../scripts/scout/europe-source-catalog.mjs';

test('owner-supplied Europe master list loads as inactive source leads with explicit territory boundaries', () => {
  const catalog=loadEuropeSourceCatalog(),summary=validateEuropeSourceCatalog(catalog),all=listEuropeSourceCandidates({catalog});
  assert.ok(summary.source_count >= 40);
  assert.deepEqual(summary.excluded_jurisdictions,['GB-ENG','GB-WLS','IM']);
  assert.ok(summary.separate_jurisdictions.includes('GB-SCT'));
  assert.ok(all.some(source=>source.country_code==='GB'&&source.jurisdiction_id==='GB-SCT'));
  assert.ok(all.some(source=>source.source_id==='be-vlg-wegenregister'));
  assert.ok(all.some(source=>source.source_id==='be-wal-spw-road-network'));
  assert.ok(all.some(source=>source.source_id==='ba-rs-transport-pending'));
  assert.ok(all.some(source=>source.source_id==='tr-kgm-road-information'));
  assert.ok(all.every(source=>source.assessment_state==='REVIEW_REQUIRED'&&source.automation_enabled===false&&source.reuse_verified===false));
  assert.ok(all.every(source=>Object.values(source.permissions).every(value=>value===false)));
  assert.ok(all.every(source=>source.authority_state==='UNVERIFIED'&&source.automation_state==='DISABLED_REVIEW_REQUIRED'));
  assert.ok(all.every(source=>source.roles.legal_motorcycle_access==='NOT_ESTABLISHED'));
  assert.ok(all.every(source=>!source.download_url));
  assert.deepEqual(listEuropeSourceCandidates({countryCode:'BE',catalog}).map(source=>source.source_id).sort(),[
    'be-vlg-wegenregister','be-wal-spw-road-network',
  ]);
});

test('roles distinguish network evidence, restriction feeds, live conditions and catalogue-only leads',()=>{
  const catalog=loadEuropeSourceCatalog(),rows=listEuropeSourceCandidates({catalog}),byId=Object.fromEntries(rows.map(row=>[row.source_id,row]));
  assert.equal(byId['es-cnig-redes-transporte'].roles.discovery_physical_network,'POTENTIAL_UNVERIFIED');
  assert.equal(byId['es-cnig-redes-transporte'].roles.legal_motorcycle_access,'NOT_ESTABLISHED');
  assert.equal(byId['is-umferdin-conditions'].roles.restrictions_closures,'POTENTIAL_UNVERIFIED');
  assert.equal(byId['is-umferdin-conditions'].roles.live_conditions,'POTENTIAL_UNVERIFIED');
  assert.equal(byId['tr-kgm-road-information'].roles.discovery_physical_network,'POTENTIAL_UNVERIFIED');
  assert.equal(byId['tr-kgm-road-information'].roles.restrictions_closures,'POTENTIAL_UNVERIFIED');
  assert.equal(byId['tr-kgm-road-information'].roles.live_conditions,'POTENTIAL_UNVERIFIED');
  assert.equal(byId['tr-kgm-road-information'].roles.legal_motorcycle_access,'NOT_ESTABLISHED');
  assert.match(byId['tr-kgm-road-information'].missing_evidence.join(' '),/forest, village and off-road/i);
  assert.equal(byId['pt-snig-transport'].roles.discovery_physical_network,'CATALOGUE_ONLY');
  assert.equal(byId['pt-snig-transport'].roles.routing_geometry,'NOT_IDENTIFIED');
  assert.match(byId['se-nvdb'].missing_evidence.join(' '),/motorcycle applicability/i);
  assert.equal(classifyEuropeSourceRoles(byId['it-rndt-transport']).catalogue_only,true);
  const matrix=renderEuropeCoverageMatrix({countryCode:'IS',catalog});
  assert.match(matrix,/Country\/Jurisdiction \| Source \| Authority \| Role \| Licence state/);
  assert.match(matrix,/POTENTIAL_UNVERIFIED/);assert.match(matrix,/\| NO \| NO \|/);
});

test('catalogue cannot silently activate a lead or include an excluded jurisdiction', () => {
  const catalog=structuredClone(loadEuropeSourceCatalog());
  catalog.source_candidates[0].automation_enabled=true;
  assert.throws(()=>validateEuropeSourceCatalog(catalog),/cannot be activated/);
  const excluded=structuredClone(loadEuropeSourceCatalog());
  excluded.source_candidates[0].admin1_code='GB-ENG';
  assert.throws(()=>validateEuropeSourceCatalog(excluded),/explicitly excluded/);
});
