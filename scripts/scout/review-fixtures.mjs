const line=(coordinates)=>({type:'LineString',coordinates});
const feature=(geometry,properties)=>({type:'Feature',geometry,properties});
const route=[[7.42,43.735],[7.421,43.735],[7.422,43.735],[7.423,43.735],[7.424,43.735],[7.425,43.735]];
const properties=(id,classification,match,exists,access,routable,extra={})=>({id,classification,match,physical_existence:exists,motorcycle_access:access,routability:routable,review_state:access==='contradictory'?'REVIEW':'OPEN',source_id:'synthetic-routes',country_code:'MC',region:'MC-synthetic',observed_at:'2026-01-01T00:00:00Z',...extra});
export const SCOUT_REVIEW_FIXTURE=Object.freeze({
  source_routes:{type:'FeatureCollection',features:[feature(line(route),{id:'synthetic-route-001',role:'ORIGINAL_SOURCE_ROUTE',source_name:'Synthetic mixed adventure route',source_type:'TEST_FIXTURE',source_language:'en',source_miles:0.28})]},
  segments:{type:'FeatureCollection',features:[
    feature(line([route[0],route[1]]),properties('synthetic-road-1','ROAD','NEW_CANDIDATE','unknown','unknown','unknown')),
    feature(line([route[1],route[2]]),properties('synthetic-unsealed-1','UNSEALED_ROAD','NEW_CANDIDATE','probable','unknown','yes')),
    feature(line([route[2],route[3],route[4]]),properties('synthetic-trail-1','PROBABLE_OFFROAD','PARTIAL_OVERLAP','confirmed','unknown','yes',{candidate_id:'candidate-synthetic-001',jurisdictions:['MC-synthetic']})),
    feature(line([route[4],route[5]]),properties('synthetic-road-2','ROAD','NEW_CANDIDATE','unknown','unknown','unknown')),
    feature(line([[7.422,43.736],[7.423,43.736]]),properties('synthetic-confirmed-unknown-access','OFFROAD_CONFIRMED','EXACT_EXISTING','confirmed','unknown','yes',{candidate_id:'candidate-synthetic-002'})),
    feature(line([[7.424,43.736],[7.425,43.736]]),properties('synthetic-contradictory','PROBABLE_OFFROAD','POSSIBLE_PARALLEL','probable','contradictory','no',{candidate_id:'candidate-synthetic-003',open_questions:['Contradictory synthetic access evidence']})),
    feature(line([[7.42,43.737],[7.421,43.737]]),properties('synthetic-unknown','UNKNOWN','AMBIGUOUS','unknown','unknown','unknown',{candidate_id:'candidate-synthetic-004'})),
  ]},
  canonical:{type:'FeatureCollection',features:[
    feature(line([[7.422,43.735],[7.423,43.735],[7.424,43.735]]),{id:'synthetic-rtt-exact',rtt_id:'rtt-synthetic-0001',match:'EXACT_EXISTING',layer:'CANONICAL'}),
    feature(line([[7.422,43.7362],[7.423,43.7362]]),{id:'synthetic-rtt-parallel',rtt_id:'rtt-synthetic-0002',match:'POSSIBLE_PARALLEL',layer:'CANONICAL'}),
  ]}
});
