FROM golang:alpine as build
COPY . /src
WORKDIR /src
RUN cp -r ./web /web
RUN cp $(go env GOROOT)/misc/wasm/wasm_exec.js /web/wasm_exec.js
RUN GOOS=js GOARCH=wasm go build -o /web/cryptowrap.wasm ./web
RUN go build -o /bin/cpace-machine ./cmd/cpace-machine

FROM alpine:latest
RUN apk --no-cache add ca-certificates
COPY --from=build /bin/cpace-machine /bin
COPY --from=build /web /lib/cpace-machine/web
ENTRYPOINT ["/bin/cpace-machine", "server"]
