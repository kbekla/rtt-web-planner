# Thin wrapper over scripts/. R=<region> selects config/regions/<R>.yaml.
R ?= monaco
export RTT_REGION := $(R)

.PHONY: setup tools region test test-unit test-render repro serve goldens status watch report dashboard test-ai rtt-validate rtt-build test-rtt

setup:            ## install pinned npm deps, browser, git hooks and tools
	npm ci
	npx playwright install chromium
	git config core.hooksPath .githooks
	scripts/fetch-tools

tools:
	scripts/fetch-tools

region:           ## one command: snapshot -> PMTiles -> style -> tests -> promote
	scripts/pipeline $(R)

test: test-unit test-render   ## test the promoted build (or RTT_BUILD_ID=<id>)

test-unit:
	node --test 'tests/repo/*.test.mjs' 'tests/schema/*.test.mjs' 'tests/attribution/*.test.mjs'

test-render:
	npx playwright test

repro:            ## rebuild from pinned inputs and require byte-identical output
	node scripts/check-repro.mjs $(R)

serve:            ## local viewer at http://127.0.0.1:8080/viewer/?region=$(R)
	node scripts/serve.mjs

goldens:          ## accept new reference screenshots — review them first!
	npx playwright test --update-snapshots

status:           ## mapwatch: builds, pipelines, failures, host readings
	node scripts/mapwatch.mjs status

watch:            ## mapwatch: follow running builds until idle
	node scripts/mapwatch.mjs watch --until-idle

report:           ## mapwatch: write $$FACTORY_DIR/reports/latest.{json,md}
	node scripts/mapwatch.mjs report

dashboard:        ## unattended factory: worker, current job, queue, disk, thermals, last failure
	node scripts/factory/factoryctl.mjs status

test-ai:          ## live AI helper check (hybrid CPU/GPU placement); loads the model
	node --test 'tests/ai/*.test.mjs'

RTT_INPUT ?= tests/fixtures/rtt/trails-synthetic.geojson
rtt-validate:     ## RT&T trails: validate RTT_INPUT against the schema + provenance rules
	node scripts/rtt/validate.mjs $(RTT_INPUT)

rtt-build:        ## RT&T trails: validate and build RTT_INPUT into its own PMTiles
	node scripts/rtt/build-trails.mjs $(RTT_INPUT)

test-rtt:         ## RT&T trail contract, build, reproducibility, diff and separation tests
	node --test 'tests/rtt/*.test.mjs'
