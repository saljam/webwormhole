package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

const (
	// msgChunkSize is the maximum size of a WebRTC DataChannel message.
	// 64k is okay for most modern browsers, 32 is conservative.
	msgChunkSize = 32 << 10
)

type header struct {
	Name string `json:"name",omitempty`
	Size int    `json:"size",omitempty`
	Type string `json:"type",omitempty`
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
	directory := set.String("dir", ".", "directory to put downloaded files")
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
			fatalf("could not read file header: %v", err)
		}
		var h header
		err = json.Unmarshal(buf[:n], &h)
		if err != nil {
			fatalf("could not decode file header: %v", err)
		}

		f, err := os.Create(filepath.Join(*directory, filepath.Clean(h.Name)))
		if err != nil {
			fatalf("could not create output file %s: %v", h.Name, err)
		}
		fmt.Fprintf(set.Output(), "receiving %v... ", h.Name)
		written, err := io.CopyBuffer(f, io.LimitReader(c, int64(h.Size)), make([]byte, msgChunkSize))
		if err != nil {
			fatalf("\ncould not save file: %v", err)
		}
		if written != int64(h.Size) {
			fatalf("\nEOF before receiving all bytes: (%d/%d)", written, h.Size)
		}
		f.Close()
		fmt.Fprintf(set.Output(), "done\n")
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

	for _, filename := range set.Args() {
		f, err := os.Open(filename)
		if err != nil {
			fatalf("could not open file %s: %v", filename, err)
		}
		info, err := f.Stat()
		if err != nil {
			fatalf("could not stat file %s: %v", filename, err)
		}
		h, err := json.Marshal(header{
			Name: filepath.Base(filepath.Clean(filename)),
			Size: int(info.Size()),
		})
		if err != nil {
			fatalf("failed to marshal json: %v", err)
		}
		_, err = c.Write(h)
		if err != nil {
			fatalf("could not send file header: %v", err)
		}
		fmt.Fprintf(set.Output(), "sending %v... ", filepath.Base(filepath.Clean(filename)))
		written, err := io.CopyBuffer(c, f, make([]byte, msgChunkSize))
		if err != nil {
			fatalf("\ncould not send file: %v", err)
		}
		if written != info.Size() {
			fatalf("\nEOF before sending all bytes: (%d/%d)", written, info.Size())
		}
		f.Close()
		fmt.Fprintf(set.Output(), "done\n")
	}
	c.Close()
}
