FROM node:slim as jsbuild
RUN npm install -g rome typescript
WORKDIR /src
COPY ./web /src
RUN rome check
RUN tsc -t ES2018 --lib webworker,es2018 --strict sw.ts

FROM golang:alpine as gobuild
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . /src
RUN GOOS=js GOARCH=wasm go build -o ./web/webwormhole.wasm ./web
RUN cp $(go env GOROOT)/misc/wasm/wasm_exec.js ./web/wasm_exec.js
RUN go build ./cmd/ww

FROM alpine:latest
RUN apk --no-cache add ca-certificates
COPY --from=gobuild /src/ww /bin
COPY --from=gobuild /src/web /web
WORKDIR /
ENTRYPOINT ["/bin/ww", "server"]
