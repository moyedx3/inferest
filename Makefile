.PHONY: docker-build

docker-build:
	docker build --build-arg NODE_VERSION="$$(cat .node-version)" --tag inferest:local .
