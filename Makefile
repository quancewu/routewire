REGISTRY  ?= ghcr.io/quancewu
IMAGE     := routewire
PLATFORM  := linux/amd64

# Read version from src/package.json and prepend v (e.g. 1.0.0 → v1.0.0)
VERSION   := v$(shell python3 -c "import json; print(json.load(open('src/package.json'))['version'])")

# Full image references
IMG_LATEST  := $(REGISTRY)/$(IMAGE):latest
IMG_VERSION := $(REGISTRY)/$(IMAGE):$(VERSION)

.PHONY: help build push release dev-build

help:
	@echo "Usage:"
	@echo "  make build                  Build linux/amd64 image (no push)"
	@echo "  make push                   Build + push :latest"
	@echo "  make release                Build + push :latest and :$(VERSION)"
	@echo "  make dev-build              Build local image for testing (native arch)"
	@echo ""
	@echo "Override registry:  make release REGISTRY=ghcr.io/you"

## Build for amd64 and tag as latest (does not push)
build:
	docker buildx build \
		--platform $(PLATFORM) \
		--tag $(IMG_LATEST) \
		--load \
		.

## Build + push :latest
push: build
	docker push $(IMG_LATEST)

## Build + push both :latest and :<version>
release:
	docker buildx build \
		--platform $(PLATFORM) \
		--tag $(IMG_LATEST) \
		--tag $(IMG_VERSION) \
		--push \
		.
	@echo ""
	@echo "Pushed:"
	@echo "  $(IMG_LATEST)"
	@echo "  $(IMG_VERSION)"

## Fast local build for testing (native arch, not for deployment)
dev-build:
	docker build \
		--tag $(IMAGE):dev \
		.
	@echo ""
	@echo "Local image: $(IMAGE):dev"
