package graphjson

import (
	"errors"
	"math"
	"strconv"
	"unicode/utf16"
	"unicode/utf8"
)

// Parse decodes exactly one strict JSON value.
func Parse(input []byte, limits Limits) (Value, error) {
	effective := normalizedLimits(limits)
	if len(input) >= 3 && input[0] == 0xef && input[1] == 0xbb && input[2] == 0xbf {
		return nil, fail(ErrorBOMForbidden, 0, "UTF-8 BOM is forbidden")
	}
	if !utf8.Valid(input) {
		return nil, fail(ErrorUTF8Invalid, 0, "JSON input is not valid UTF-8")
	}
	parser := parser{input: input, limits: effective}
	parser.skipWhitespace()
	value, err := parser.value(1)
	if err != nil {
		return nil, err
	}
	parser.skipWhitespace()
	if parser.cursor != len(parser.input) {
		return nil, parser.failure(ErrorSyntax, parser.cursor, "unexpected trailing JSON token")
	}
	return value, nil
}

type parser struct {
	input  []byte
	cursor int
	nodes  int
	limits resolvedLimits
}

func (parser *parser) failure(code ErrorCode, byteOffset int, message string) error {
	if byteOffset < 0 {
		byteOffset = 0
	}
	if byteOffset > len(parser.input) {
		byteOffset = len(parser.input)
	}
	offset := 0
	for _, value := range string(parser.input[:byteOffset]) {
		if value > 0xffff {
			offset += 2
		} else {
			offset++
		}
	}
	return fail(code, offset, message)
}

func (parser *parser) value(depth int) (Value, error) {
	if depth > parser.limits.MaxDepth {
		return nil, parser.failure(ErrorLimit, parser.cursor, "JSON nesting depth exceeds its limit")
	}
	parser.nodes++
	if parser.nodes > parser.limits.MaxNodes {
		return nil, parser.failure(ErrorLimit, parser.cursor, "JSON node count exceeds its limit")
	}
	if parser.cursor >= len(parser.input) {
		return nil, parser.failure(ErrorSyntax, parser.cursor, "expected a JSON value")
	}
	switch parser.input[parser.cursor] {
	case '"':
		return parser.string()
	case '{':
		return parser.object(depth)
	case '[':
		return parser.array(depth)
	case 't':
		return parser.literal("true", true)
	case 'f':
		return parser.literal("false", false)
	case 'n':
		return parser.literal("null", nil)
	case '-':
		return parser.number()
	default:
		if parser.input[parser.cursor] >= '0' && parser.input[parser.cursor] <= '9' {
			return parser.number()
		}
		return nil, parser.failure(ErrorSyntax, parser.cursor, "expected a JSON value")
	}
}

func (parser *parser) object(depth int) (Value, error) {
	result := Object{}
	parser.cursor++
	parser.skipWhitespace()
	if parser.consume('}') {
		return result, nil
	}
	for {
		if parser.cursor >= len(parser.input) || parser.input[parser.cursor] != '"' {
			return nil, parser.failure(ErrorSyntax, parser.cursor, "expected a quoted JSON object key")
		}
		keyOffset := parser.cursor
		rawKey, err := parser.string()
		if err != nil {
			return nil, err
		}
		key := rawKey.(string)
		if _, exists := result[key]; exists {
			return nil, parser.failure(ErrorDuplicateKey, keyOffset, "duplicate JSON object key")
		}
		parser.skipWhitespace()
		if !parser.consume(':') {
			return nil, parser.failure(ErrorSyntax, parser.cursor, "expected a colon after JSON object key")
		}
		parser.skipWhitespace()
		member, err := parser.value(depth + 1)
		if err != nil {
			return nil, err
		}
		result[key] = member
		parser.skipWhitespace()
		if parser.consume('}') {
			return result, nil
		}
		if !parser.consume(',') {
			return nil, parser.failure(ErrorSyntax, parser.cursor, "expected a comma or closing object brace")
		}
		parser.skipWhitespace()
		if parser.cursor < len(parser.input) && parser.input[parser.cursor] == '}' {
			return nil, parser.failure(ErrorSyntax, parser.cursor, "trailing commas are not valid JSON")
		}
	}
}

func (parser *parser) array(depth int) (Value, error) {
	result := Array{}
	parser.cursor++
	parser.skipWhitespace()
	if parser.consume(']') {
		return result, nil
	}
	for {
		item, err := parser.value(depth + 1)
		if err != nil {
			return nil, err
		}
		result = append(result, item)
		parser.skipWhitespace()
		if parser.consume(']') {
			return result, nil
		}
		if !parser.consume(',') {
			return nil, parser.failure(ErrorSyntax, parser.cursor, "expected a comma or closing array bracket")
		}
		parser.skipWhitespace()
		if parser.cursor < len(parser.input) && parser.input[parser.cursor] == ']' {
			return nil, parser.failure(ErrorSyntax, parser.cursor, "trailing commas are not valid JSON")
		}
	}
}

func (parser *parser) string() (Value, error) {
	start := parser.cursor
	parser.cursor++
	buffer := make([]byte, 0, 32)
	length := 0
	for parser.cursor < len(parser.input) {
		current := parser.input[parser.cursor]
		parser.cursor++
		switch current {
		case '"':
			return string(buffer), nil
		case '\\':
			escaped, units, err := parser.escape(start)
			if err != nil {
				return nil, err
			}
			buffer = utf8.AppendRune(buffer, escaped)
			length += units
		default:
			if current <= 0x1f {
				return nil, parser.failure(ErrorSyntax, parser.cursor-1, "unescaped control character")
			}
			if current < utf8.RuneSelf {
				buffer = append(buffer, current)
				length++
			} else {
				parser.cursor--
				decoded, size := utf8.DecodeRune(parser.input[parser.cursor:])
				buffer = append(buffer, parser.input[parser.cursor:parser.cursor+size]...)
				parser.cursor += size
				if decoded > 0xffff {
					length += 2
				} else {
					length++
				}
			}
		}
		if length > parser.limits.MaxStringLength {
			return nil, parser.failure(ErrorLimit, parser.cursor, "JSON string exceeds its limit")
		}
	}
	return nil, parser.failure(ErrorSyntax, start, "unterminated JSON string")
}

func (parser *parser) escape(stringStart int) (rune, int, error) {
	if parser.cursor >= len(parser.input) {
		return 0, 0, parser.failure(ErrorSyntax, parser.cursor, "incomplete escape sequence")
	}
	escaped := parser.input[parser.cursor]
	parser.cursor++
	switch escaped {
	case '"', '\\', '/':
		return rune(escaped), 1, nil
	case 'b':
		return '\b', 1, nil
	case 'f':
		return '\f', 1, nil
	case 'n':
		return '\n', 1, nil
	case 'r':
		return '\r', 1, nil
	case 't':
		return '\t', 1, nil
	case 'u':
		first, err := parser.hexCodeUnit()
		if err != nil {
			return 0, 0, err
		}
		if first >= 0xdc00 && first <= 0xdfff {
			return 0, 0, parser.failure(ErrorSyntax, stringStart, "JSON string contains an unpaired Unicode surrogate")
		}
		if first < 0xd800 || first > 0xdbff {
			return rune(first), 1, nil
		}
		if parser.cursor+2 > len(parser.input) ||
			parser.input[parser.cursor] != '\\' ||
			parser.input[parser.cursor+1] != 'u' {
			return 0, 0, parser.failure(ErrorSyntax, stringStart, "JSON string contains an unpaired Unicode surrogate")
		}
		parser.cursor += 2
		second, err := parser.hexCodeUnit()
		if err != nil {
			return 0, 0, err
		}
		if second < 0xdc00 || second > 0xdfff {
			return 0, 0, parser.failure(ErrorSyntax, stringStart, "JSON string contains an unpaired Unicode surrogate")
		}
		return utf16.DecodeRune(rune(first), rune(second)), 2, nil
	default:
		return 0, 0, parser.failure(ErrorSyntax, parser.cursor-1, "invalid escape sequence")
	}
}

func (parser *parser) hexCodeUnit() (uint16, error) {
	if parser.cursor+4 > len(parser.input) {
		return 0, parser.failure(ErrorSyntax, parser.cursor, "incomplete Unicode escape")
	}
	var result uint16
	for index := 0; index < 4; index++ {
		current := parser.input[parser.cursor+index]
		result <<= 4
		switch {
		case current >= '0' && current <= '9':
			result += uint16(current - '0')
		case current >= 'a' && current <= 'f':
			result += uint16(current-'a') + 10
		case current >= 'A' && current <= 'F':
			result += uint16(current-'A') + 10
		default:
			return 0, parser.failure(ErrorSyntax, parser.cursor+index, "invalid Unicode escape")
		}
	}
	parser.cursor += 4
	return result, nil
}

func (parser *parser) number() (Value, error) {
	start := parser.cursor
	if parser.consume('-') && parser.cursor >= len(parser.input) {
		return nil, parser.failure(ErrorSyntax, start, "invalid JSON number")
	}
	if parser.consume('0') {
		if parser.cursor < len(parser.input) && parser.input[parser.cursor] >= '0' && parser.input[parser.cursor] <= '9' {
			return nil, parser.failure(ErrorSyntax, parser.cursor, "leading zero in JSON number")
		}
	} else {
		if parser.cursor >= len(parser.input) || parser.input[parser.cursor] < '1' || parser.input[parser.cursor] > '9' {
			return nil, parser.failure(ErrorSyntax, start, "invalid JSON number")
		}
		for parser.cursor < len(parser.input) && parser.input[parser.cursor] >= '0' && parser.input[parser.cursor] <= '9' {
			parser.cursor++
		}
	}
	if parser.consume('.') {
		fractionStart := parser.cursor
		for parser.cursor < len(parser.input) && parser.input[parser.cursor] >= '0' && parser.input[parser.cursor] <= '9' {
			parser.cursor++
		}
		if fractionStart == parser.cursor {
			return nil, parser.failure(ErrorSyntax, parser.cursor, "fraction requires a digit")
		}
	}
	if parser.cursor < len(parser.input) && (parser.input[parser.cursor] == 'e' || parser.input[parser.cursor] == 'E') {
		parser.cursor++
		if parser.cursor < len(parser.input) && (parser.input[parser.cursor] == '+' || parser.input[parser.cursor] == '-') {
			parser.cursor++
		}
		exponentStart := parser.cursor
		for parser.cursor < len(parser.input) && parser.input[parser.cursor] >= '0' && parser.input[parser.cursor] <= '9' {
			parser.cursor++
		}
		if exponentStart == parser.cursor {
			return nil, parser.failure(ErrorSyntax, parser.cursor, "exponent requires a digit")
		}
	}
	if parser.cursor < len(parser.input) && !isNumberDelimiter(parser.input[parser.cursor]) {
		return nil, parser.failure(ErrorSyntax, parser.cursor, "invalid token after JSON number")
	}
	value, err := strconv.ParseFloat(string(parser.input[start:parser.cursor]), 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return nil, parser.failure(ErrorSyntax, start, "invalid JSON number")
	}
	if math.IsInf(value, 0) || math.IsNaN(value) {
		return nil, parser.failure(ErrorSyntax, start, "JSON number is not finite")
	}
	return value, nil
}

func isNumberDelimiter(value byte) bool {
	switch value {
	case '\t', '\n', '\r', ' ', ',', '}', ']':
		return true
	default:
		return false
	}
}

func (parser *parser) literal(lexeme string, value Value) (Value, error) {
	if parser.cursor+len(lexeme) > len(parser.input) ||
		string(parser.input[parser.cursor:parser.cursor+len(lexeme)]) != lexeme {
		return nil, parser.failure(ErrorSyntax, parser.cursor, "invalid JSON literal")
	}
	parser.cursor += len(lexeme)
	return value, nil
}

func (parser *parser) consume(expected byte) bool {
	if parser.cursor >= len(parser.input) || parser.input[parser.cursor] != expected {
		return false
	}
	parser.cursor++
	return true
}

func (parser *parser) skipWhitespace() {
	for parser.cursor < len(parser.input) {
		switch parser.input[parser.cursor] {
		case '\t', '\n', '\r', ' ':
			parser.cursor++
		default:
			return
		}
	}
}
