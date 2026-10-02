// Autonomy rules, failure classifier and the approved remediation registry.
//
// This file is AUTHORITATIVE. The worker acts only on what these rules allow.
// The optional local AI helper may summarise a failure and *suggest* a class or
// remediation, but a suggestion is applied only if it is in AI_SELECTABLE, is
// allowed for the job, and has retry budget left. AI suggestions never override
// a RED or AMBER outcome from the rules below.
//
// Autonomy levels:
//   GREEN  the worker acts on its own (bounded by retry budgets)
//   AMBER  the job is held; it continues only after a human approves it
//          (`factoryctl approve <job>` or `factoryctl release <job>`)
//   RED    the whole queue stops; nothing runs until a human clears it
//          (`factoryctl clear-red`)

/** Approved remediations. None of them edit repo files, config, styles, goldens or code. */
export const REMEDIATIONS = {
  'resume': {
    level: 'GREEN',
    max: 3,
    description: 'Re-run the interrupted job from its last checkpoint. Completed steps are skipped or cheaply re-verified.',
  },
  'retry-after-backoff': {
    level: 'GREEN',
    max: 2,
    description: 'Wait (5 min, then 30 min) and retry the job unchanged. For transient network failures.',
  },
  'retry-reduced-threads': {
    level: 'GREEN',
    max: 1,
    description: 'Retry with half the Planetiler threads. Thread count does not affect tile bytes or the build ID.',
  },
  'clean-scratch': {
    level: 'GREEN',
    max: 1,
    description: 'Delete stale factory scratch directories (no live process), then re-check the disk guard and retry.',
  },
  'retry-render-tests': {
    level: 'GREEN',
    max: 1,
    description: 'Re-run the pipeline once, for a browser render-test timeout. Screenshot mismatches are never retried.',
  },
  'hold': {
    level: 'AMBER',
    max: Infinity,
    description: 'Hold the job for human review. Nothing is retried or changed.',
  },
  'stop-queue': {
    level: 'RED',
    max: Infinity,
    description: 'Stop the whole queue. For integrity failures, unexpected repo changes or refused jobs.',
  },
};

/** Remediations the AI helper may pick for a failure the rules classify as `unknown`. */
export const AI_SELECTABLE = ['resume', 'retry-after-backoff', 'retry-reduced-threads', 'retry-render-tests', 'hold'];

/**
 * Failure classes, in priority order: the first match wins. Each maps to exactly
 * one remediation. Patterns are matched against the error text plus log tail.
 */
export const CLASSES = [
  { id: 'integrity', remediation: 'stop-queue',
    why: 'A pinned input, tool or output failed its checksum. Never retried: it may be corruption or tampering.',
    re: /sha256 mismatch|does not match (lock|tools\.lock|config\/ancillary\.lock)|md5 mismatch|sha256 [0-9a-f]{64} != (lock )?[0-9a-f]{64}/i },
  { id: 'refused', remediation: 'stop-queue',
    why: 'The job was refused by policy, e.g. a full-planet build.',
    re: /REFUSED:/ },
  { id: 'disk-full', remediation: 'clean-scratch',
    why: 'The disk filled up during the job.',
    re: /No space left on device|ENOSPC|disk guard: insufficient/i },
  { id: 'oom', remediation: 'retry-reduced-threads',
    why: 'The JVM or the kernel ran out of memory.',
    re: /OutOfMemoryError|Cannot allocate memory|oom-kill|Out of memory: Killed process|exit(ed)? (with )?(code )?137\b.*(oom|memory)/i },
  { id: 'interrupted', remediation: 'resume',
    why: 'The job was stopped by a signal, a service restart or a reboot. Its work is incomplete but not wrong.',
    re: /interrupted by SIG(TERM|INT|KILL|HUP)|process exited without recording a result|worker restarted|state: aborted/i },
  { id: 'network', remediation: 'retry-after-backoff',
    why: 'A download failed for a transient network reason.',
    re: /Could not resolve host|Connection (timed out|refused|reset)|curl: \((6|7|28|35|52|56)\)|Temporary failure in name resolution|HTTP\/[\d.]+ (502|503|504)|The requested URL returned error: (502|503|504)/i },
  { id: 'render-timeout', remediation: 'retry-render-tests',
    why: 'A browser render test timed out waiting for the map. This can be a transient slowdown.',
    re: /waitForFunction: Timeout \d+ms exceeded|Test timeout of \d+ms exceeded/i },
  { id: 'test-failure', remediation: 'hold',
    why: 'A schema, attribution, repo or screenshot test failed. Data or style changed; a human must review it.',
    re: /Screenshot comparison failed|pixels \(ratio [\d.]+\) are different|not ok \d+ -|AssertionError|ERR_ASSERTION|\d+ failed/i },
];

export const UNKNOWN = { id: 'unknown', remediation: 'hold', why: 'No rule matched. A human must look at it.' };

/** Classify a failure. `text` is the error message plus the log tail. */
export function classify(text) {
  for (const c of CLASSES) if (c.re.test(text)) return { class: c.id, remediation: c.remediation, why: c.why };
  return { class: UNKNOWN.id, remediation: UNKNOWN.remediation, why: UNKNOWN.why };
}

/**
 * Decide what to do with a failed job.
 * @param job        queue job (uses job.remediations: { id: count })
 * @param text       error + log tail
 * @param suggestion optional AI suggestion { remediation, summary }
 * @returns { class, remediation, level, why, source }
 */
export function decide(job, text, suggestion = null) {
  const c = classify(text);
  let remediation = c.remediation;
  let source = 'rules';
  if (c.class === 'unknown' && suggestion && AI_SELECTABLE.includes(suggestion.remediation)) {
    // Small local models are unreliable judges (see docs/FACTORY.md): one
    // AI-chosen remediation per job, then a human looks at it.
    if ((job.ai_remediations ?? 0) >= 1 && suggestion.remediation !== 'hold') {
      return { class: c.class, remediation: 'hold', level: 'AMBER', source: 'rules',
        why: `${c.why} The AI already chose a remediation for this job once; holding for review.` };
    }
    remediation = suggestion.remediation;
    source = 'ai';
  }
  const used = job.remediations?.[remediation] ?? 0;
  const r = REMEDIATIONS[remediation];
  if (r.level === 'GREEN' && used >= r.max) {
    return { class: c.class, remediation: 'hold', level: 'AMBER', source: 'rules',
      why: `${c.why} Retry budget for '${remediation}' is used up (${used}/${r.max}).` };
  }
  // A job-wide cap keeps any mix of remediations from looping.
  const total = Object.entries(job.remediations ?? {}).filter(([k]) => REMEDIATIONS[k]?.level === 'GREEN')
    .reduce((n, [, v]) => n + v, 0);
  if (r.level === 'GREEN' && total >= 4) {
    return { class: c.class, remediation: 'hold', level: 'AMBER', source: 'rules',
      why: `${c.why} The job has used ${total} automatic remediations; holding for review.` };
  }
  return { class: c.class, remediation, level: r.level, why: c.why, source };
}
