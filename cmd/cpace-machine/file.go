package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
)

const (
	// msgChunkSize is the maximum size of a WebRTC DataChannel message.
	// 64k is okay for modern browsers.
	msgChunkSize = 64 << 10
)

type header struct {
	Name string
	Size int
	Type string
}

func receive(args ...string) {
	set := flag.NewFlagSet(args[0], flag.ExitOnError)
	set.Usage = func() {
		fmt.Fprintf(set.Output(), "receive files\n\n")
		fmt.Fprintf(set.Output(), "usage: %s %s [code]\n\n", os.Args[0], args[0])
		fmt.Fprintf(set.Output(), "flags:\n")
		set.PrintDefaults()
	}
	length := set.Int("length", 2, "length of generated secret, if generating")
	directory := set.String("directory", ".", "directory to put downloaded files")
	set.Parse(args[1:])

	if set.NArg() > 1 {
		set.Usage()
		os.Exit(2)
	}
	c := newConn(set.Arg(0), *length)

	// TODO append number to existing filenames?

	for {
		// First message is the header. 1k should be enough.
		buf := make([]byte, 1<<10)
		n, err := c.Read(buf)
		if err == io.EOF {
			break
		}
		if err != nil {
			log.Fatalf("could not read file header: %v", err)
		}
		var h header
		err = json.Unmarshal(buf[:n], &h)
		if err != nil {
			log.Fatalf("could not decode file header: %v", err)
		}

		f, err := os.Create(filepath.Join(*directory, filepath.Clean(h.Name)))
		if err != nil {
			log.Fatalf("could not create output file %s: %v", h.Name, err)
		}
		log.Printf("Receiving %v", h.Name)

		written, err := io.CopyBuffer(f, io.LimitReader(c, int64(h.Size)), make([]byte, msgChunkSize))
		if err != nil {
			log.Fatalf("could not save file: %v", err)
		}
		if written != int64(h.Size) {
			log.Fatalf("EOF before receiving all bytes: (%d/%d)", written, h.Size)
		}
		f.Close()
		log.Printf("Done")
	}
	c.Close()
}

func send(args ...string) {
	set := flag.NewFlagSet(args[0], flag.ExitOnError)
	set.Usage = func() {
		fmt.Fprintf(set.Output(), "send files\n\n")
		fmt.Fprintf(set.Output(), "usage: %s %s [files]...\n\n", os.Args[0], args[0])
		fmt.Fprintf(set.Output(), "flags:\n")
		set.PrintDefaults()
	}
	length := set.Int("length", 2, "length of generated secret")
	code := set.String("code", "", "use a wormhole code instead of generating one")
	set.Parse(args[1:])

	if set.NArg() < 1 {
		set.Usage()
		os.Exit(2)
	}
	c := newConn(*code, *length)
	// TODO
	c.Close()
}
