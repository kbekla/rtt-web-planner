import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveScoutProductState, deriveResearchWorkflow, publicScoutStatus, routeUseDecision } from '../../scripts/scout/product-model.mjs';
import { PUBLIC_TILE_FIELDS } from '../../scripts/rtt/publish-check.mjs';

const lane = (overrides={}) => ({routeKind:'LANE',physicalExistence:'probable',physicalCharacter:'PROBABLE_OFFROAD',credibleDiscovery:true,...overrides});
const product = (overrides={}) => deriveScoutProductState(lane(overrides));

test('ordinary road, verified, unverified, restriction and temporary-closure product states', () => {
  assert.equal(product({routeKind:'ORDINARY_ROAD',physicalCharacter:'ROAD'}),'ORDINARY_ROAD');
  assert.equal(product({physicalExistence:'confirmed',motorcycleAccess:'confirmed',accessEvaluation:{access:'confirmed'}}),'GREEN');
  assert.equal(product({physicalExistence:'confirmed',motorcycleAccess:'confirmed'}),'ORANGE');
  assert.equal(product({motorcycleAccess:'unknown'}),'ORANGE');
  assert.equal(product({motorcycleAccess:'prohibited'}),'RED');
  assert.equal(product({motorcycleAccess:'temporarily_restricted'}),'TEMPORARILY_CLOSED');
  assert.equal(product({restriction:{active:true}}),'TEMPORARILY_CLOSED');
  assert.equal(product({restriction:{positive_motorcycle_prohibition:true}}),'RED');
});

test('unknown evidence remains orange, never red; physically disproved geometry is not a route', () => {
  assert.equal(product({motorcycleAccess:'unknown'}),'ORANGE');
  assert.equal(product({physicalExistence:'disproved'}),'NOT_A_ROUTE');
  assert.equal(product({physicalExistence:'unknown',physicalCharacter:'UNKNOWN',credibleDiscovery:false}),'NOT_A_ROUTE');
  assert.equal(product({physicalExistence:'unknown',credibleDiscovery:true}),'ORANGE');
  assert.equal(product({physicalExistence:'probable',physicalCharacter:'UNKNOWN'}),'ORANGE');
});

test('positive restriction and active temporary restriction override normal and lane status correctly', () => {
  assert.equal(product({routeKind:'ORDINARY_ROAD',physicalCharacter:'ROAD',motorcycleAccess:'prohibited'}),'RED');
  assert.equal(product({routeKind:'ORDINARY_ROAD',physicalCharacter:'ROAD',restriction:{active:true}}),'TEMPORARILY_CLOSED');
  assert.equal(product({motorcycleAccess:'confirmed',restriction:{active:true}}),'TEMPORARILY_CLOSED');
  assert.equal(product({motorcycleAccess:'confirmed',restriction:{positive_motorcycle_prohibition:true}}),'RED');
  assert.equal(product({motorcycleAccess:'prohibited',restriction:{active:true}}),'RED');
  assert.equal(product({motorcycleAccess:'unknown',restriction:{positive_motorcycle_prohibition:false}}),'ORANGE');
});

test('jurisdiction verification is explicit and open-unless-restricted is not a global default', () => {
  assert.equal(product({motorcycleAccess:'unknown'}),'ORANGE');
  assert.equal(product({jurisdictionPolicy:{access_model:'OPEN_UNLESS_RESTRICTED',recognized_public_route:true,current_restriction_check:'COMPLETE'}}),'GREEN');
  assert.equal(product({jurisdictionPolicy:{access_model:'OPEN_UNLESS_RESTRICTED',recognized_public_route:true,current_restriction_check:'STALE'}}),'ORANGE');
  assert.equal(product({jurisdictionPolicy:{access_model:'OPEN_UNLESS_RESTRICTED',recognized_public_route:false,current_restriction_check:'COMPLETE'}}),'ORANGE');
  assert.equal(product({jurisdictionPolicy:{access_model:'UK_EXPLICIT_STATUS_REQUIRED',recognized_public_route:true,current_restriction_check:'COMPLETE'}}),'ORANGE');
  assert.equal(product({motorcycleAccess:'confirmed',accessEvaluation:{access:'confirmed'},jurisdictionPolicy:{access_model:'UK_EXPLICIT_STATUS_REQUIRED'}}),'GREEN');
});

test('physical existence, legal access and routability stay independent', () => {
  assert.equal(product({physicalExistence:'confirmed',motorcycleAccess:'unknown',routability:'yes'}),'ORANGE');
  assert.equal(product({physicalExistence:'probable',motorcycleAccess:'confirmed',accessEvaluation:{access:'confirmed'},routability:'no'}),'GREEN');
  assert.equal(product({physicalExistence:'probable',motorcycleAccess:'unknown',routability:'yes'}),'ORANGE');
  assert.equal(product({physicalExistence:'confirmed',motorcycleAccess:'unknown',routability:'no'}),'ORANGE');
});

test('automatic route selection is normal-road and green only, with connected geometry required', () => {
  assert.equal(routeUseDecision({productState:'ORDINARY_ROAD',mode:'AUTO',geometryAvailable:true,routability:'yes'}).allowed,true);
  assert.equal(routeUseDecision({productState:'GREEN',mode:'AUTO',geometryAvailable:true,routability:'yes'}).allowed,true);
  assert.equal(routeUseDecision({productState:'GREEN',mode:'AUTO',geometryAvailable:true,routability:'unknown'}).allowed,false);
  assert.equal(routeUseDecision({productState:'ORANGE',mode:'AUTO',geometryAvailable:true,routability:'yes'}).allowed,false);
  assert.equal(routeUseDecision({productState:'RED',mode:'AUTO',geometryAvailable:true,routability:'yes'}).allowed,false);
  assert.equal(routeUseDecision({productState:'TEMPORARILY_CLOSED',mode:'AUTO',geometryAvailable:true,routability:'yes'}).allowed,false);
});

test('deliberately selected and imported orange routes work; red/active closure never does', () => {
  for(const mode of ['MANUAL','CREATE','IMPORT'])assert.equal(routeUseDecision({productState:'ORANGE',mode,geometryAvailable:true,routability:'unknown'}).allowed,true);
  assert.equal(routeUseDecision({productState:'ORANGE',mode:'MANUAL',geometryAvailable:false}).allowed,false);
  assert.equal(routeUseDecision({productState:'ORANGE',mode:'MANUAL',geometryAvailable:false,routability:'yes'}).allowed,false);
  assert.equal(routeUseDecision({productState:'ORANGE',mode:'IMPORT',geometryAvailable:true,routability:'no'}).allowed,false);
  for(const mode of ['MANUAL','CREATE','IMPORT']){
    assert.equal(routeUseDecision({productState:'RED',mode,geometryAvailable:true,routability:'yes'}).allowed,false);
    assert.equal(routeUseDecision({productState:'TEMPORARILY_CLOSED',mode,geometryAvailable:true,routability:'yes'}).allowed,false);
  }
});

test('research state separates automatic research from genuine owner escalation', () => {
  assert.equal(deriveResearchWorkflow({reviewState:'UNREVIEWED',productState:'ORANGE'}),'SCOUT_RESEARCH_REQUIRED');
  assert.equal(deriveResearchWorkflow({reviewState:'NEEDS_MORE_EVIDENCE',productState:'ORANGE'}),'SCOUT_RESEARCH_REQUIRED');
  assert.equal(deriveResearchWorkflow({reviewState:'CATALOGUED',productState:'ORANGE'}),'AUTO_RESOLVED');
  assert.equal(deriveResearchWorkflow({reviewState:'LOW_VALUE',productState:'ORANGE'}),'AUTO_RESOLVED');
  assert.equal(deriveResearchWorkflow({sourceLicenceUnclear:true}),'HUMAN_ESCALATION');
  assert.equal(deriveResearchWorkflow({authoritativeConflict:true}),'HUMAN_ESCALATION');
  assert.equal(deriveResearchWorkflow({reviewState:'UNREVIEWED',productState:'ORANGE',authoritativeConflict:true}),'HUMAN_ESCALATION');
  assert.equal(deriveResearchWorkflow({geometryIdentity:'REVIEW_REQUIRED'}),'HUMAN_ESCALATION');
  assert.equal(deriveResearchWorkflow({reviewState:'AMBIGUOUS'}),'HUMAN_ESCALATION');
  assert.equal(deriveResearchWorkflow({qaSample:true}),'QA_SAMPLE');
});

test('public status projection suppresses private discovery provenance and canonical whitelist remains unchanged', () => {
  const view=publicScoutStatus({productState:'ORANGE'});
  assert.equal(view.label,'Unverified lane');
  assert.match(view.detail,/has not verified access/i);
  assert.deepEqual(Object.keys(view).sort(),['detail','label','notice','status','status_source'].sort());
  assert.match(view.notice,/check local signs, restrictions and conditions/i);
  assert.equal(JSON.stringify(view).includes('TET'),false);
  assert.equal(JSON.stringify(view).includes('source_id'),false);
  assert.deepEqual(PUBLIC_TILE_FIELDS,['rtt_id','name','kind','access']);
  const official=publicScoutStatus({productState:'TEMPORARILY_CLOSED',authorityName:'Example Highway Authority',authorityDirectlySupportsStatus:true,restrictionUntil:'2026-10-31'});
  assert.equal(official.status_source,'Example Highway Authority');
  assert.match(official.detail,/2026-10-31/);
  assert.equal(publicScoutStatus({productState:'TEMPORARILY_CLOSED',authorityName:'Private GPX',authorityDirectlySupportsStatus:false}).status_source,null);
});
