import crypto from 'node:crypto';

// This is a non-destructive hypothesis based on shared, version-pinned
// network-edge identities. Geographic closeness alone never creates a group.
export function groupObservedCorridors(items,{minimumSharedEdges=2,minimumCoverage=0.8}={}) {
  if(!Array.isArray(items)||!Number.isInteger(minimumSharedEdges)||minimumSharedEdges<1||!Number.isFinite(minimumCoverage)||minimumCoverage<=0||minimumCoverage>1)throw new Error('invalid corridor grouping input or thresholds');
  const sorted=[...items].sort((a,b)=>a.candidate_id.localeCompare(b.candidate_id));
  const normalized=sorted.map((item)=>({item,edgeIds:new Set((item.evidence??[]).filter((e)=>e.rule==='nearest-network-edge'&&e.edge_id).map((e)=>e.edge_id))}));
  const parent=normalized.map((_,i)=>i),find=(i)=>parent[i]===i?i:(parent[i]=find(parent[i])),join=(a,b)=>{const x=find(a),y=find(b);if(x!==y)parent[Math.max(x,y)]=Math.min(x,y);};
  const links=[];
  for(let i=0;i<normalized.length;i++)for(let j=i+1;j<normalized.length;j++) {
    const a=normalized[i],b=normalized[j];if(!a.item.network_snapshot_id||a.item.network_snapshot_id!==b.item.network_snapshot_id)continue;
    const common=[...a.edgeIds].filter((id)=>b.edgeIds.has(id)).sort(),denominator=Math.min(a.edgeIds.size,b.edgeIds.size);
    if(common.length>=minimumSharedEdges&&denominator>0&&common.length/denominator>=minimumCoverage){join(i,j);links.push({candidate_ids:[a.item.candidate_id,b.item.candidate_id],shared_edge_ids:common});}
  }
  const groups=new Map();normalized.forEach((item,i)=>{const root=find(i);if(!groups.has(root))groups.set(root,[]);groups.get(root).push(item);});
  return [...groups.values()].filter((members)=>members.length>1).map((members)=>{
    const candidate_ids=members.map((m)=>m.item.candidate_id).sort(),snapshot=members[0].item.network_snapshot_id;
    const corridor_id=`corridor-${crypto.createHash('sha256').update(JSON.stringify([snapshot,candidate_ids])).digest('hex').slice(0,24)}`;
    return {corridor_id,network_snapshot_id:snapshot,candidate_ids,
      observation_ids:[...new Set(members.map((m)=>m.item.observation_id).filter(Boolean))].sort(),
      links:links.filter((link)=>link.candidate_ids.every((id)=>candidate_ids.includes(id))),hypothesis:'SHARED_VERSIONED_NETWORK_EDGES',destructive_merge:false};
  }).sort((a,b)=>a.corridor_id.localeCompare(b.corridor_id));
}
