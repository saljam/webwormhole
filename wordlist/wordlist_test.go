package wordlist

import (
	"reflect"
	"testing"
)

func TestEnEncodeDecode(t *testing.T) {
	cases := []struct {
		slot int
		pass []byte
		code string
	}{
		{0, nil, ""},
		{2, []byte{0}, "affix-acre"},
		{2, []byte{0, 0}, "affix-acre-acorn"},
		{2, []byte{8, 8}, "affix-aloft-aloe"},
		{127, []byte{1}, "knelt-afar"},
		{128, []byte{1}, "ladle-afar-acts"},
		{255, []byte{1}, "zippy-afar-acts"},
		{256, []byte{1}, "ladle-aged-acts"},
		{256, []byte{8, 8}, "ladle-aged-aloe-aloft"},
	}
	for i, c := range cases {
		if code := Encode(c.slot, c.pass); code != c.code {
			t.Errorf("encode testcase %v got %v want %v", i, code, c.code)
		}
	}
	for i, c := range cases {
		if slot, pass := Decode(c.code); slot != c.slot || !reflect.DeepEqual(pass, c.pass) {
			t.Errorf("decode testcase %v got %v,%v want %v,%v", i, slot, pass, c.slot, c.pass)
		}
	}
}

func TestMatch(t *testing.T) {
	cases := []struct {
		prefix string
		word   string
	}{
		{"", ""},
		{"a", "acorn"},
		{"ac", "acorn"},
		{"act", "acts"},
		{"acre-", ""},
		{"acre-b", ""},
		{"zo", "zone"},
		{"acre-b", ""},
		{"zz", ""},
		{"snaps", "snapshot"}, // fallback to gpg words
	}
	for i, c := range cases {
		if hint := Match(c.prefix); hint != c.word {
			t.Errorf("testcase %v (%v) got %v want %v", i, c.prefix, hint, c.word)
		}
	}

}
