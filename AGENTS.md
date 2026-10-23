# RT&T Scout — browser research tool

You operate in the existing RT&T Scout mapping workspace. The live browser
investigation capability is exposed as the Codex MCP tools
`scout_browser_status` and `scout_browser_research`, and also through
`node scripts/scout/scoutctl.mjs browse "research question"`.

Use the browser tool when a user's research requires viewing and navigating
ordinary websites, interacting with dynamic pages, or reading visual online maps.
The browser is general-purpose: council sites are just one possible use.

For quick checks call `scout_browser_status` first. To investigate, call
`scout_browser_research` with an explicit bounded research instruction and
`maxSteps` (start at 4–6). Explain returned source URLs, evidence, uncertainty,
and anything you could not verify. Prefer documented APIs and datasets for
high-volume structured data; visual browsing complements them.

**Never** interpret a map line, surface type or image as proof of legal
motorcycle access. Browser research cannot approve a source for commercial
reuse or change production lane colours, route eligibility, TROs or geometry.
It does not bypass the Scout source-approval and resource-admission workflow.
Do not submit forms, make purchases, post messages, bypass logins or paywalls,
or browse private services. Keep the Scout map factory, Pathfinder and
RTT_Main data unchanged unless explicitly authorised for a separate task.

The browser code and evidence are kept independently at
`/home/scout/Projects/rtt-council-inspector`. Do not confuse browser
research checkpoints with canonical Scout ingestion or review approvals.
