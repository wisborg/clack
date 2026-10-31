# The discoverable front door: every target delegates to tools/dev, which is
# where each job is actually spelled out. Do not add a target that does the
# work itself -- a second spelling of a job is how the two drift apart.

.PHONY: help build typecheck test gates tsgo clean

help:
	@go run ./tools/dev help

build:
	go run ./tools/dev build

typecheck:
	go run ./tools/dev typecheck

# make test BROWSERS=chrome,firefox
test:
	go run ./tools/dev test $(if $(BROWSERS),-browsers=$(BROWSERS))

gates:
	go run ./tools/dev gates

tsgo:
	go run ./tools/dev tsgo

clean:
	go run ./tools/dev clean
