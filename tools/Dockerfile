FROM golang:alpine as build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . /src
RUN cp -r ./web /web
RUN cp $(go env GOROOT)/misc/wasm/wasm_exec.js /web/wasm_exec.js
RUN GOOS=js GOARCH=wasm go build -o /web/util.wasm ./web
RUN go build -o /bin/ww ./cmd/ww

FROM alpine:latest
RUN apk --no-cache add ca-certificates
COPY --from=build /bin/ww /bin
COPY --from=build /web /lib/webwormhole/web
ENTRYPOINT ["/bin/ww", "server"]
