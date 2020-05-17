package wordlist

import (
	"reflect"
	"testing"
)

func TestEncode(t *testing.T) {
	cases := []struct {
		in  []byte
		out []string
	}{
		{[]byte{}, []string{}},
		{[]byte{0}, []string{"aardvark"}},
		{[]byte{1}, []string{"absurd"}},
		{[]byte{8, 8}, []string{"aimless", "antenna"}},
		{[]byte{19, 52}, []string{"aztec", "confidence"}},
	}
	for i := range cases {
		if out := Encode(cases[i].in); reflect.DeepEqual(out, cases[i].out) != true {
			t.Errorf("testcase %v got %v want %v", i, out, cases[i].out)
		}
	}

}

func TestDecode(t *testing.T) {
	cases := []struct {
		words  []string
		bytes  []byte
		parity []byte
	}{
		{[]string{}, []byte{}, []byte{}},
		{[]string{"aardvark"}, []byte{0}, []byte{0}},
		{[]string{"ADRoitness"}, []byte{0}, []byte{1}},
		{[]string{"aimless", "antenna", "cleanup"}, []byte{8, 8, 58}, []byte{0, 1, 0}},
		{[]string{"Aztec", "confidence", "notaword"}, nil, nil},
	}
	for i := range cases {
		bytes, parity := Decode(cases[i].words)
		if reflect.DeepEqual(bytes, cases[i].bytes) != true ||
			reflect.DeepEqual(parity, cases[i].parity) != true {
			t.Errorf("testcase %v got %v,%v want %v,%v", i, bytes, parity, cases[i].bytes, cases[i].parity)
		}
	}

}
