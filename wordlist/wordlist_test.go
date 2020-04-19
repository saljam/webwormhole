package wordlist

import (
	"reflect"
	"testing"
)

func TestEncodeWords(t *testing.T) {
	cases := []struct {
		in  []byte
		out []string
	}{
		{[]byte{}, []string{}},
		{[]byte{0}, []string{"aardvark"}},
		{[]byte{1}, []string{"absurd"}},
		{[]byte{8, 8}, []string{"aimless", "antenna"}},
		{[]byte{19, 52}, []string{"Aztec", "confidence"}},
	}
	for i := range cases {
		if out := EncodeWords(cases[i].in); reflect.DeepEqual(out, cases[i].out) != true {
			t.Errorf("testcase %v got %v want %v", i, out, cases[i].out)
		}
	}

}

func TestDecodeWords(t *testing.T) {
	cases := []struct {
		words  []string
		bytes  []byte
		parity []byte
		ok     bool
	}{
		{[]string{}, []byte{}, []byte{}, true},
		{[]string{"aardvark"}, []byte{0}, []byte{0}, true},
		{[]string{"ADRoitness"}, []byte{0}, []byte{1}, true},
		{[]string{"aimless", "antenna", "cleanup"}, []byte{8, 8, 58}, []byte{0, 1, 0}, true},
		{[]string{"Aztec", "confidence", "notaword"}, []byte{19, 52}, []byte{0, 1}, false},
	}
	for i := range cases {
		bytes, parity, ok := DecodeWords(cases[i].words)
		if reflect.DeepEqual(bytes, cases[i].bytes) != true ||
			reflect.DeepEqual(parity, cases[i].parity) != true ||
			cases[i].ok != ok {
			t.Errorf("testcase %v got %v,%v,%v want %v,%v,%v", i, bytes, parity, ok, cases[i].bytes, cases[i].parity, cases[i].ok)
		}
	}

}
