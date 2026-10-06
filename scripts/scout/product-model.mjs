/** Rider-facing Scout states derived from, but never replacing, private evidence. */
export const SCOUT_PRODUCT_STATES = Object.freeze([
  'ORDINARY_ROAD', 'GREEN', 'ORANGE', 'RED', 'TEMPORARILY_CLOSED', 'NOT_A_ROUTE',
]);
export const RTT_ACCESS_NOTICE = 'RT&T works to keep route and restriction information current, but access and conditions can change. Riders must check local signs, restrictions and conditions before proceeding.';

/**
 * Jurisdiction-specific verification is explicit input. Unknown jurisdictions
 * fail to ORANGE; absence of data is never treated as a prohibition.
 */
export function deriveScoutProductState({
  routeKind = 'LANE', physicalExistence = 'unknown', physicalCharacter = 'UNKNOWN',
  motorcycleAccess = 'unknown', routability = 'unknown', accessEvaluation = null,
  credibleDiscovery = false, restriction = null, jurisdictionPolicy = null,
} = {}) {
  const ordinaryRoad = routeKind === 'ORDINARY_ROAD' || physicalCharacter === 'ROAD';
  const legalState = accessEvaluation?.operational_state;
  const positiveProhibition = restriction?.positive_motorcycle_prohibition === true || motorcycleAccess === 'prohibited' || legalState === 'RESTRICTED_OR_REJECTED';
  if (positiveProhibition) return 'RED';
  const temporary = restriction?.active === true || motorcycleAccess === 'temporarily_restricted' || legalState === 'TEMPORARILY_CLOSED';
  if (temporary) return 'TEMPORARILY_CLOSED';
  if (ordinaryRoad) return 'ORDINARY_ROAD';

  const credible = physicalExistence !== 'disproved' && (
    physicalExistence === 'probable' || physicalExistence === 'confirmed' || credibleDiscovery ||
    ['UNSEALED_ROAD', 'PROBABLE_OFFROAD', 'OFFROAD_CONFIRMED'].includes(physicalCharacter)
  );
  if (!credible) return 'NOT_A_ROUTE';

  // Require the access evaluator's output, which has already enforced source,
  // authority, date, affected-geometry and jurisdiction identity gates.
  const authoritativeAccess = motorcycleAccess === 'confirmed' && accessEvaluation?.access === 'confirmed';
  const openUnlessRestricted = jurisdictionPolicy?.access_model === 'OPEN_UNLESS_RESTRICTED' &&
    jurisdictionPolicy?.recognized_public_route === true && jurisdictionPolicy?.current_restriction_check === 'COMPLETE';
  if (authoritativeAccess || openUnlessRestricted) return 'GREEN';
  return 'ORANGE';
}

/** The router policy is deliberately mode-specific and separate from evidence. */
export function routeUseDecision({ productState, mode = 'AUTO', geometryAvailable = false, routability = 'unknown' } = {}) {
  const normalizedMode = String(mode).toUpperCase();
  if (!['AUTO', 'MANUAL', 'CREATE', 'IMPORT'].includes(normalizedMode)) throw new Error('route mode must be AUTO, MANUAL, CREATE, or IMPORT');
  if (productState === 'RED') return { allowed: false, reason: 'positive motor-vehicle restriction' };
  if (productState === 'TEMPORARILY_CLOSED') return { allowed: false, reason: 'active dated restriction' };
  if (!geometryAvailable || routability === 'no' || routability === 'contradictory') return { allowed: false, reason: 'usable connected route geometry is unavailable' };
  if (productState === 'NOT_A_ROUTE') return { allowed: false, reason: 'not a Scout lane or road route' };
  if (productState === 'ORANGE' && normalizedMode === 'AUTO') return { allowed: false, reason: 'automatic routing does not select unverified lanes' };
  if (productState === 'GREEN' && normalizedMode === 'AUTO' && routability !== 'yes') return { allowed: false, reason: 'automatic routing requires verified connected geometry' };
  if (!['ORDINARY_ROAD', 'GREEN', 'ORANGE'].includes(productState)) return { allowed: false, reason: 'unknown product state' };
  return { allowed: true, reason: productState === 'ORANGE' ? 'rider deliberately selected an unverified lane' : 'route is eligible for this mode' };
}

/** Research workload is not a request for Karl to decide foreign-road law. */
export function deriveResearchWorkflow({ reviewState = 'CATALOGUED', productState = 'ORANGE', sourceLicenceUnclear = false,
  authoritativeConflict = false, geometryIdentity = 'MATCHED', qaSample = false } = {}) {
  if (qaSample) return 'QA_SAMPLE';
  if (sourceLicenceUnclear || authoritativeConflict || geometryIdentity === 'REVIEW_REQUIRED' || ['HUMAN_ESCALATION', 'AMBIGUOUS', 'HOLD'].includes(reviewState)) return 'HUMAN_ESCALATION';
  if (['UNREVIEWED', 'NEEDS_MORE_EVIDENCE'].includes(reviewState) || (productState === 'ORANGE' && reviewState !== 'LOW_VALUE' && reviewState !== 'CATALOGUED')) return 'SCOUT_RESEARCH_REQUIRED';
  if (productState === 'ORANGE' && reviewState === 'CORROBORATED_DISCOVERY') return 'SCOUT_RESEARCH_REQUIRED';
  return 'AUTO_RESOLVED';
}

/** Safe public display projection: no per-feature source or evidence attribution. */
export function publicScoutStatus({ productState, restrictionUntil = null } = {}) {
  const labels = { ORDINARY_ROAD: 'Ordinary road', GREEN: 'Verified lane', ORANGE: 'Unverified lane', RED: 'Not allowed / Do not enter', TEMPORARILY_CLOSED: 'Temporarily closed' };
  const detail = productState === 'ORANGE'
    ? 'RT&T believes a route exists here but has not verified access. Check local signs, restrictions and conditions before proceeding.'
    : productState === 'GREEN' ? 'Verified using RT&T’s current route/access information.'
      : productState === 'RED' ? 'RT&T has positive information that motor vehicles should not use this route.'
        : productState === 'TEMPORARILY_CLOSED' ? `A current temporary restriction applies${restrictionUntil ? ` until ${restrictionUntil}` : ''}.` : null;
  return { status: productState, label: labels[productState] ?? 'Route status unavailable', detail, notice: RTT_ACCESS_NOTICE };
}

/**
 * Public projection for a separately licensed partner layer. This deliberately
 * does not accept Scout evidence/cross-reference fields. Partner-authored status
 * and notes are exposed only when the registered agreement explicitly permits
 * each field. Dataset attribution is returned separately by
 * projectDataAcknowledgements(), never attached to a route feature.
 */
export function projectPartnerLayerFeature({ agreement = {}, geometry, partnerContent = {} } = {}) {
  if (typeof agreement.partner_id !== 'string' || !agreement.partner_id.trim() || typeof agreement.permission_reference !== 'string' || !agreement.permission_reference.trim()) {
    throw new Error('partner permission reference is required');
  }
  if (agreement.public_geometry_display !== true || agreement.public_status_display !== true) {
    throw new Error('partner agreement does not authorize public route/status display');
  }
  if (!geometry || !['LineString', 'MultiLineString'].includes(geometry.type) || !Array.isArray(geometry.coordinates)) {
    throw new Error('partner layer geometry must be a line');
  }
  const status = boundedPublicText(partnerContent.status, 120, 'partner status');
  if (!status) throw new Error('partner-provided status is required');
  const properties = { status };
  if (agreement.public_notes_display === true && partnerContent.note !== undefined && partnerContent.note !== null) {
    const note = boundedPublicText(partnerContent.note, 2000, 'partner note');
    if (!note) throw new Error('partner note must be plain text');
    properties.note = note;
  }
  // No source feature ID, partner ID, agreement reference, or Scout match is
  // emitted. The partner layer itself is managed separately from Scout output.
  return { type: 'Feature', properties, geometry };
}

/** General acknowledgements are dataset-level credits, with no feature linkage. */
export function projectDataAcknowledgements(sources = []) {
  if (!Array.isArray(sources)) throw new Error('acknowledgements must be a list');
  const credits = new Set();
  for (const source of sources) {
    if (source?.public_credit !== true) continue;
    const credit = boundedPublicText(source.attribution, 500, 'dataset attribution');
    if (!credit) throw new Error('publicly used source with attribution rights needs a dataset-level credit');
    credits.add(credit);
  }
  return [...credits].sort().map(text => ({ text }));
}

function boundedPublicText(value, maxLength, label) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (text.length > maxLength || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) throw new Error(`${label} is invalid or exceeds its display limit`);
  return text;
}
