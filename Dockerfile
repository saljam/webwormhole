FROM golang:alpine as build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . /src
RUN go generate ./web
RUN go build ./cmd/ww

FROM alpine:latest
RUN apk --no-cache add ca-certificates
COPY --from=build /src/ww /bin
COPY --from=build /src/web /web
WORKDIR /
ENTRYPOINT ["/bin/ww", "server"]
