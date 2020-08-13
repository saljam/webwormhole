// Package wordlist provides a encoders and a decoder for WebWormhole codes.
package wordlist

import (
	"encoding/binary"
	"fmt"
	"strconv"
	"strings"
)

var defaultEncodings = []encoding{
	varintEncoding(enWords),
	magicWormholeEncoding(enWords),
	magicWormholeEncoding(pgpWords),
	octalEncoding{},
}

// Encode returns the string encoding of slot and pass using the default encoding,
// which is english-varint-slot.
func Encode(slot int, pass []byte) string {
	return defaultEncodings[0].Encode(slot, pass)
}

// Encode returns the slot and pass encoded by code, trying all supported word lists
// supported in the default order. Invalid codes return a 0 slot and a nil pass.
func Decode(code string) (slot int, pass []byte) {
	for _, enc := range defaultEncodings {
		s, p := enc.Decode(code)
		if p != nil {
			return s, p
		}
	}
	return 0, nil
}

// Match returns the first word in the word list that has prefix prefix, trying all
// supported word lists the default order. It returns the empty string if none match.
func Match(prefix string) string {
	for _, enc := range defaultEncodings {
		hint := enc.Match(prefix)
		if hint != "" {
			return hint
		}
	}
	return ""
}

// encoding is a string encoding for a vector of bytes.
type encoding interface {
	// Encode returns the string encoding of slot and pass.
	Encode(slot int, pass []byte) string
	// Encode returns the slot and pass encoded by code.
	Decode(code string) (slot int, pass []byte)
	// Match returns the first word in the word list that has prefix prefix.
	Match(prefix string) string
}

// octalEncoding map is a numeric encoding of the codes.
type octalEncoding struct{}

func (octalEncoding) Encode(slot int, pass []byte) string {
	if len(pass) == 0 {
		return ""
	}

	code := fmt.Sprintf("%o", slot)
	for i, b := range pass {
		code += fmt.Sprintf("-%03o", int(b)|((i&1)<<8)) // each byte b + a 9th parity bit
	}
	return code
}

func (octalEncoding) Decode(code string) (slot int, pass []byte) {
	// White space and - are interchangable.
	code = strings.ReplaceAll(code, "-", " ")
	// Space can turn into + in URLs.
	code = strings.ReplaceAll(code, "+", " ")
	parts := strings.Fields(code)
	if len(parts) < 2 {
		return 0, nil
	}

	s, err := strconv.ParseInt(parts[0], 8, 64)
	if err != nil {
		return 0, nil
	}

	pass = make([]byte, len(parts[1:]))
	for i, p := range parts[1:] {
		n, err := strconv.ParseInt(p, 8, 16)
		if err != nil {
			return 0, nil
		}
		if int((n>>8)&1) != i%2 {
			return 0, nil
		}
		pass[i] = byte(n & 0xff)
	}
	return int(s), pass
}

func (octalEncoding) Match(prefix string) string { return "" }

// varintEncoding maps codes into a word for each byte, with the slot encoded as a
// varint at the start. E.g. foo-bar-baz.
type varintEncoding []string

func (list varintEncoding) Encode(slot int, pass []byte) string {
	if len(pass) == 0 {
		return ""
	}
	slotbytes := make([]byte, binary.MaxVarintLen64)
	n := binary.PutUvarint(slotbytes, uint64(slot))
	slotbytes = slotbytes[:n]

	words := make([]string, n+len(pass))
	for i := range slotbytes {
		words[i] = list[int(slotbytes[i])*2+i%2]
	}
	for i := range pass {
		words[n+i] = list[int(pass[i])*2+(n+i)%2]
	}
	return strings.Join(words, "-")
}

func (list varintEncoding) Decode(code string) (slot int, pass []byte) {
	// White space and - are interchangable.
	code = strings.ReplaceAll(code, "-", " ")
	// Space can turn into + in URLs.
	code = strings.ReplaceAll(code, "+", " ")
	parts := strings.Fields(code)

	buf := make([]byte, len(parts))
	for i := range parts {
		j := indexOf([]string(list), parts[i])
		if j < 0 {
			return 0, nil
		}
		buf[i] = byte(j / 2)
		if i%2 != j%2 {
			return 0, nil
		}
	}

	s, n := binary.Uvarint(buf)
	if n <= 0 {
		return 0, nil
	}
	return int(s), buf[n:]
}

func (list varintEncoding) Match(prefix string) string {
	return match([]string(list), prefix)
}

// magicWormholeEncoding maps codes into a word for each byte, with the slot encoded
// as an integer at the start. E.g. 5-foo-bar.
type magicWormholeEncoding []string

func (list magicWormholeEncoding) Encode(slot int, pass []byte) string {
	if len(pass) == 0 {
		return ""
	}
	code := fmt.Sprintf("%d", slot)
	for i := range pass {
		code += fmt.Sprintf("-%s", list[int(pass[i])*2+i%2])
	}
	return code
}

func (list magicWormholeEncoding) Decode(code string) (slot int, pass []byte) {
	// White space and - are interchangable.
	code = strings.ReplaceAll(code, "-", " ")
	// Space can turn into + in URLs.
	code = strings.ReplaceAll(code, "+", " ")
	parts := strings.Fields(code)
	if len(parts) < 2 {
		return 0, nil
	}

	slot, err := strconv.Atoi(parts[0])
	if err != nil {
		return 0, nil
	}

	pass = make([]byte, len(parts[1:]))
	for i, p := range parts[1:] {
		j := indexOf(list, p)
		if j < 0 {
			return 0, nil // word not in dict
		}
		pass[i] = byte(j / 2)
		if i%2 != j%2 {
			return 0, nil // bad parity
		}
	}
	return slot, pass
}

func (list magicWormholeEncoding) Match(prefix string) string {
	return match([]string(list), prefix)
}

// indexOf finds the index of word in list. It returns -1 if it is not in the list.
func indexOf(list []string, word string) int {
	for i := range list {
		if strings.EqualFold(word, list[i]) {
			return i
		}
	}
	return -1
}

func match(list []string, prefix string) string {
	if prefix == "" {
		return ""
	}
	for i := range list {
		if strings.HasPrefix(list[i], prefix) {
			return list[i]
		}
	}
	return ""
}

// enWords is based on the EFF short wordlist, filtered by unique soundex.
// https://www.eff.org/deeplinks/2016/07/new-wordlists-random-passphrases
// Credit to Nick Moore https://nick.zoic.org/art/shorter-words-list/
var enWords = []string{
	"acorn", "acre",
	"acts", "afar",
	"affix", "aged",
	"agent", "agile",
	"aging", "agony",
	"aide", "aids",
	"aim", "alarm",
	"alike", "alive",
	"aloe", "aloft",
	"alone", "amend",
	"ample", "amuse",
	"angel", "anger",
	"apple", "april",
	"apron", "area",
	"argue", "armed",
	"armor", "army",
	"arson", "art",
	"atlas", "atom",
	"avert", "avoid",
	"axis", "bacon",
	"baker", "balmy",
	"barn", "basil",
	"baton", "bats",
	"blank", "blast",
	"blend", "blimp",
	"blob", "blog",
	"blurt", "boil",
	"bok", "bolt",
	"bony", "bribe",
	"bring", "broad",
	"broil", "broke",
	"bud", "bunch",
	"bunt", "bust",
	"calm", "canal",
	"candy", "card",
	"case", "cedar",
	"chump", "civic",
	"civil", "clamp",
	"clasp", "class",
	"clay", "clear",
	"cleft", "clerk",
	"cling", "clip",
	"cold", "come",
	"comic", "cork",
	"cost", "cover",
	"craft", "cramp",
	"crank", "crisp",
	"crop", "crown",
	"crust", "cub",
	"cupid", "cure",
	"curl", "cut",
	"cycle", "dab",
	"dad", "dart",
	"deal", "debt",
	"debug", "decaf",
	"decal", "decor",
	"dent", "dig",
	"dimly", "ditch",
	"doing", "donor",
	"down", "drab",
	"drank", "dress",
	"drift", "drill",
	"drum", "dry",
	"dust", "early",
	"earth", "east",
	"eaten", "ebony",
	"echo", "edge",
	"eel", "elder",
	"elf", "elk",
	"elm", "elude",
	"elves", "email",
	"emit", "empty",
	"emu", "enter",
	"envoy", "equal",
	"erase", "error",
	"erupt", "evade",
	"even", "evict",
	"evil", "evoke",
	"fable", "fact",
	"fall", "fang",
	"femur", "fend",
	"fetal", "fetch",
	"fever", "fifth",
	"film", "final",
	"fit", "five",
	"flag", "fled",
	"fling", "flint",
	"flip", "flirt",
	"flyer", "foam",
	"fox", "frail",
	"fray", "fresh",
	"from", "front",
	"frost", "fruit",
	"gap", "gas",
	"gem", "genre",
	"gift", "given",
	"giver", "glad",
	"glass", "goal",
	"golf", "gong",
	"grab", "grant",
	"grasp", "grass",
	"green", "grew",
	"grid", "grill",
	"gut", "habit",
	"halt", "harm",
	"hasty", "hatch",
	"haven", "hazel",
	"help", "herbs",
	"hers", "hub",
	"hug", "hull",
	"human", "hump",
	"hung", "hunt",
	"hurry", "hurt",
	"hut", "ice",
	"icing", "icon",
	"igloo", "image",
	"ion", "iron",
	"item", "ivory",
	"ivy", "jam",
	"jet", "job",
	"jog", "jolt",
	"judge", "july",
	"jump", "junky",
	"jury", "keep",
	"keg", "kept",
	"kilt", "king",
	"kite", "knee",
	"knelt", "koala",
	"ladle", "lake",
	"land", "last",
	"latch", "left",
	"legal", "lens",
	"level", "lid",
	"lilac", "lily",
	"limb", "line",
	"lip", "liver",
	"lunar", "lure",
	"lurk", "maker",
	"mango", "manor",
	"map", "march",
	"mardi", "marry",
	"match", "malt",
	"mom", "most",
	"motor", "mount",
	"mud", "mug",
	"mulch", "mule",
	"mumbo", "mural",
	"nag", "nail",
	"name", "nap",
	"near", "nerd",
	"net", "next",
	"ninth", "oak",
	"oat", "ocean",
	"oil", "old",
	"olive", "omen",
	"only", "open",
	"opera", "opt",
	"ounce", "outer",
	"oval", "pagan",
	"palm", "pants",
	"paper", "park",
	"party", "patch",
	"pep", "perm",
	"pest", "petal",
	"petri", "plank",
	"plant", "plot",
	"plus", "pod",
	"poem", "poker",
	"polar", "pond",
	"prank", "print",
	"prism", "proof",
	"props", "pry",
	"pug", "pull",
	"pulp", "punk",
	"pupil", "quake",
	"query", "quill",
	"quit", "rabid",
	"radar", "raft",
	"ramp", "rank",
	"rant", "recap",
	"relax", "reply",
	"rerun", "rigor",
	"ritzy", "river",
	"robin", "rope",
	"rug", "ruin",
	"rule", "rust",
	"rut", "salt",
	"same", "scale",
	"scan", "scold",
	"score", "scorn",
	"scrap", "sect",
	"self", "send",
	"set", "seven",
	"share", "shirt",
	"shrug", "silk",
	"silo", "sip",
	"siren", "skip",
	"skirt", "sky",
	"slam", "slang",
	"slept", "slurp",
	"small", "smirk",
	"smog", "snap",
	"snare", "snarl",
	"snort", "speak",
	"spent", "spill",
	"sport", "spot",
	"spur", "stamp",
	"stand", "stark",
	"start", "stem",
	"sting", "stir",
	"stole", "stop",
	"storm", "suds",
	"surf", "swirl",
	"tag", "tall",
	"talon", "tamer",
	"tank", "taper",
	"taps", "tart",
	"taste", "theft",
	"thumb", "tidal",
	"tidy", "tiger",
	"tilt", "tint",
	"tiny", "train",
	"trap", "trek",
	"trend", "trial",
	"trunk", "try",
	"tulip", "tutor",
	"uncle", "uncut",
	"unify", "union",
	"unit", "upon",
	"upper", "urban",
	"used", "user",
	"utter", "value",
	"vapor", "vegan",
	"venue", "vest",
	"vice", "viral",
	"virus", "visor",
	"vocal", "void",
	"volt", "voter",
	"wad", "wafer",
	"wager", "wagon",
	"walk", "wasp",
	"watch", "water",
	"widen", "wife",
	"wilt", "wind",
	"wing", "wiry",
	"wok", "wolf",
	"womb", "wool",
	"word", "work",
	"woven", "wrist",
	"xerox", "yam",
	"yard", "year",
	"yeast", "yelp",
	"yield", "yodel",
	"yoga", "zebra",
	"zero", "zesty",
	"zippy", "zone",
}

// pgpWords is the PGP word list encoding.
// https://en.wikipedia.org/wiki/PGP_word_list
var pgpWords = []string{
	"aardvark", "adroitness",
	"absurd", "adviser",
	"accrue", "aftermath",
	"acme", "aggregate",
	"adrift", "alkali",
	"adult", "almighty",
	"afflict", "amulet",
	"ahead", "amusement",
	"aimless", "antenna",
	"algol", "applicant",
	"allow", "apollo",
	"alone", "armistice",
	"ammo", "article",
	"ancient", "asteroid",
	"apple", "atlantic",
	"artist", "atmosphere",
	"assume", "autopsy",
	"athens", "babylon",
	"atlas", "backwater",
	"aztec", "barbecue",
	"baboon", "belowground",
	"backfield", "bifocals",
	"backward", "bodyguard",
	"banjo", "bookseller",
	"beaming", "borderline",
	"bedlamp", "bottomless",
	"beehive", "bradbury",
	"beeswax", "bravado",
	"befriend", "brazilian",
	"belfast", "breakaway",
	"berserk", "burlington",
	"billiard", "businessman",
	"bison", "butterfat",
	"blackjack", "camelot",
	"blockade", "candidate",
	"blowtorch", "cannonball",
	"bluebird", "capricorn",
	"bombast", "caravan",
	"bookshelf", "caretaker",
	"brackish", "celebrate",
	"breadline", "cellulose",
	"breakup", "certify",
	"brickyard", "chambermaid",
	"briefcase", "cherokee",
	"burbank", "chicago",
	"button", "clergyman",
	"buzzard", "coherence",
	"cement", "combustion",
	"chairlift", "commando",
	"chatter", "company",
	"checkup", "component",
	"chisel", "concurrent",
	"choking", "confidence",
	"chopper", "conformist",
	"christmas", "congregate",
	"clamshell", "consensus",
	"classic", "consulting",
	"classroom", "corporate",
	"cleanup", "corrosion",
	"clockwork", "councilman",
	"cobra", "crossover",
	"commence", "crucifix",
	"concert", "cumbersome",
	"cowbell", "customer",
	"crackdown", "dakota",
	"cranky", "decadence",
	"crowfoot", "december",
	"crucial", "decimal",
	"crumpled", "designing",
	"crusade", "detector",
	"cubic", "detergent",
	"dashboard", "determine",
	"deadbolt", "dictator",
	"deckhand", "dinosaur",
	"dogsled", "direction",
	"dragnet", "disable",
	"drainage", "disbelief",
	"dreadful", "disruptive",
	"drifter", "distortion",
	"dropper", "document",
	"drumbeat", "embezzle",
	"drunken", "enchanting",
	"dupont", "enrollment",
	"dwelling", "enterprise",
	"eating", "equation",
	"edict", "equipment",
	"egghead", "escapade",
	"eightball", "eskimo",
	"endorse", "everyday",
	"endow", "examine",
	"enlist", "existence",
	"erase", "exodus",
	"escape", "fascinate",
	"exceed", "filament",
	"eyeglass", "finicky",
	"eyetooth", "forever",
	"facial", "fortitude",
	"fallout", "frequency",
	"flagpole", "gadgetry",
	"flatfoot", "galveston",
	"flytrap", "getaway",
	"fracture", "glossary",
	"framework", "gossamer",
	"freedom", "graduate",
	"frighten", "gravity",
	"gazelle", "guitarist",
	"geiger", "hamburger",
	"glitter", "hamilton",
	"glucose", "handiwork",
	"goggles", "hazardous",
	"goldfish", "headwaters",
	"gremlin", "hemisphere",
	"guidance", "hesitate",
	"hamlet", "hideaway",
	"highchair", "holiness",
	"hockey", "hurricane",
	"indoors", "hydraulic",
	"indulge", "impartial",
	"inverse", "impetus",
	"involve", "inception",
	"island", "indigo",
	"jawbone", "inertia",
	"keyboard", "infancy",
	"kickoff", "inferno",
	"kiwi", "informant",
	"klaxon", "insincere",
	"locale", "insurgent",
	"lockup", "integrate",
	"merit", "intention",
	"minnow", "inventive",
	"miser", "istanbul",
	"mohawk", "jamaica",
	"mural", "jupiter",
	"music", "leprosy",
	"necklace", "letterhead",
	"neptune", "liberty",
	"newborn", "maritime",
	"nightbird", "matchmaker",
	"oakland", "maverick",
	"obtuse", "medusa",
	"offload", "megaton",
	"optic", "microscope",
	"orca", "microwave",
	"payday", "midsummer",
	"peachy", "millionaire",
	"pheasant", "miracle",
	"physique", "misnomer",
	"playhouse", "molasses",
	"pluto", "molecule",
	"preclude", "montana",
	"prefer", "monument",
	"preshrunk", "mosquito",
	"printer", "narrative",
	"prowler", "nebula",
	"pupil", "newsletter",
	"puppy", "norwegian",
	"python", "october",
	"quadrant", "ohio",
	"quiver", "onlooker",
	"quota", "opulent",
	"ragtime", "orlando",
	"ratchet", "outfielder",
	"rebirth", "pacific",
	"reform", "pandemic",
	"regain", "pandora",
	"reindeer", "paperweight",
	"rematch", "paragon",
	"repay", "paragraph",
	"retouch", "paramount",
	"revenge", "passenger",
	"reward", "pedigree",
	"rhythm", "pegasus",
	"ribcage", "penetrate",
	"ringbolt", "perceptive",
	"robust", "performance",
	"rocker", "pharmacy",
	"ruffled", "phonetic",
	"sailboat", "photograph",
	"sawdust", "pioneer",
	"scallion", "pocketful",
	"scenic", "politeness",
	"scorecard", "positive",
	"scotland", "potato",
	"seabird", "processor",
	"select", "provincial",
	"sentence", "proximate",
	"shadow", "puberty",
	"shamrock", "publisher",
	"showgirl", "pyramid",
	"skullcap", "quantity",
	"skydive", "racketeer",
	"slingshot", "rebellion",
	"slowdown", "recipe",
	"snapline", "recover",
	"snapshot", "repellent",
	"snowcap", "replica",
	"snowslide", "reproduce",
	"solo", "resistor",
	"southward", "responsive",
	"soybean", "retraction",
	"spaniel", "retrieval",
	"spearhead", "retrospect",
	"spellbind", "revenue",
	"spheroid", "revival",
	"spigot", "revolver",
	"spindle", "sandalwood",
	"spyglass", "sardonic",
	"stagehand", "saturday",
	"stagnate", "savagery",
	"stairway", "scavenger",
	"standard", "sensation",
	"stapler", "sociable",
	"steamship", "souvenir",
	"sterling", "specialist",
	"stockman", "speculate",
	"stopwatch", "stethoscope",
	"stormy", "stupendous",
	"sugar", "supportive",
	"surmount", "surrender",
	"suspense", "suspicious",
	"sweatband", "sympathy",
	"swelter", "tambourine",
	"tactics", "telephone",
	"talon", "therapist",
	"tapeworm", "tobacco",
	"tempest", "tolerance",
	"tiger", "tomorrow",
	"tissue", "torpedo",
	"tonic", "tradition",
	"topmost", "travesty",
	"tracker", "trombonist",
	"transit", "truncated",
	"trauma", "typewriter",
	"treadmill", "ultimate",
	"trojan", "undaunted",
	"trouble", "underfoot",
	"tumor", "unicorn",
	"tunnel", "unify",
	"tycoon", "universe",
	"uncut", "unravel",
	"unearth", "upcoming",
	"unwind", "vacancy",
	"uproot", "vagabond",
	"upset", "vertigo",
	"upshot", "virginia",
	"vapor", "visitor",
	"village", "vocalist",
	"virus", "voyager",
	"vulcan", "warranty",
	"waffle", "waterloo",
	"wallet", "whimsical",
	"watchword", "wichita",
	"wayside", "wilmington",
	"willow", "wyoming",
	"woodlark", "yesteryear",
	"zulu", "yucatan",
}
