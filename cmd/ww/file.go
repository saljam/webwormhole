package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
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

// find a suitable filename to receive a file. if the path already exist, append a suffix or increment the existing suffix
func getUniquePath(path string) string {

	if _, err := os.Stat(path); err != nil {
		return path
	}

	// find the last . (dot char)
	lastDot := strings.LastIndex(path, ".")
	filenameAndSuffix, extension := path[:lastDot], path[lastDot:]
	lastUnderscore := strings.LastIndex(filenameAndSuffix, "_")
	// if there's no underscore found, add it to the filename
	if lastUnderscore == -1 {
		return getUniquePath(fmt.Sprintf("%s_%d%s", filenameAndSuffix, 1, extension))
	}
	// if there's already an underscore, check to see if it's a number, if it is, increment it, otherwise, add the underscore as if there was none
	filename, suffix := filenameAndSuffix[:lastUnderscore], filenameAndSuffix[lastUnderscore:]
	// check if suffix is a number
	if n, err := strconv.Atoi(suffix[1:]); err == nil {
		//increment and re-call the function just in case there are multiple files being replaced
		return getUniquePath(fmt.Sprintf("%s_%d%s", filename, n+1, extension))
	}

	return getUniquePath(fmt.Sprintf("%s_%d%s", filenameAndSuffix, 1, extension))

}

// Test_getUniquePath is a simple test suite for above getUniquePath function.
// NOTE: it is very unlikely that you'd have filenames like the ones created below
// but proceed with caution nonetheless
func Test_getUniquePath(t *testing.T) {
	unixNano := time.Now().Format("2006-01-02T15:04:05.999999-07:00")
	ext := "txt"
	f1 := fmt.Sprintf("%s.%s", unixNano, ext)
	_, _ = os.Create(f1)
	defer os.Remove(f1)
	f2 := fmt.Sprintf("%s_1.%s", unixNano, ext)
	_, _ = os.Create(f2)
	defer os.Remove(f2)
	f3 := fmt.Sprintf("%s_notnumber.%s", unixNano, ext)
	_, _ = os.Create(f3)
	defer os.Remove(f3)

	tests := []struct {
		name string
		path string
		want string
	}{
		// test1 should return _2 because _1 already exists
		{name: "test1", path: f1, want: fmt.Sprintf("%s_2.%s", unixNano, ext)},
		// test2 should return _2 because it's an increment to _1
		{name: "test2", path: f2, want: fmt.Sprintf("%s_2.%s", unixNano, ext)},
		{name: "test3", path: f3, want: fmt.Sprintf("%s_notnumber_1.%s", unixNano, ext)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := getUniquePath(tt.path); got != tt.want {
				t.Errorf("getUniquePath() = %v, want %v", got, tt.want)
			}
		})
	}
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

		f, err := os.Create(getUniquePath(filepath.Join(*directory, filepath.Clean(h.Name))))
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
