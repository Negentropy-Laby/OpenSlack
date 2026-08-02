package canonicaljson

import (
	"math"
	"strconv"
	"unicode/utf16"
	"unicode/utf8"
)

func Parse(input []byte, limits Limits) (Value, error) {
	if len(input) >= 3 && input[0] == 0xef && input[1] == 0xbb && input[2] == 0xbf {
		return nil, parseFail(ErrorBOM, 0, "UTF-8 BOM is forbidden")
	}
	if !utf8.Valid(input) {
		return nil, parseFail(ErrorUTF8Invalid, 0, "JSON input is not valid UTF-8")
	}
	if limits.MaxDepth < 1 || limits.MaxNodes < 1 || limits.MaxStringLength < 1 {
		return nil, parseFail(ErrorLimit, 0, "JSON limits must be positive")
	}
	parser := parser{input: input, limits: limits}
	parser.skipWhitespace()
	value, err := parser.value(1)
	if err != nil {
		return nil, err
	}
	parser.skipWhitespace()
	if parser.cursor != len(parser.input) {
		return nil, parseFail(ErrorSyntax, parser.cursor, "unexpected trailing JSON token")
	}
	return value, nil
}

type parser struct {
	input  []byte
	cursor int
	nodes  int
	limits Limits
}

func (parser *parser) value(depth int) (Value, error) {
	if depth > parser.limits.MaxDepth {
		return nil, parseFail(ErrorLimit, parser.cursor, "JSON nesting depth exceeds its limit")
	}
	parser.nodes++
	if parser.nodes > parser.limits.MaxNodes {
		return nil, parseFail(ErrorLimit, parser.cursor, "JSON node count exceeds its limit")
	}
	if parser.cursor >= len(parser.input) {
		return nil, parseFail(ErrorSyntax, parser.cursor, "expected a JSON value")
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
		return nil, parseFail(ErrorSyntax, parser.cursor, "expected a JSON value")
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
			return nil, parseFail(ErrorSyntax, parser.cursor, "expected a quoted JSON object key")
		}
		keyOffset := parser.cursor
		rawKey, err := parser.string()
		if err != nil {
			return nil, err
		}
		key := rawKey.(string)
		if _, exists := result[key]; exists {
			return nil, parseFail(ErrorDuplicate, keyOffset, "duplicate JSON object key")
		}
		parser.skipWhitespace()
		if !parser.consume(':') {
			return nil, parseFail(ErrorSyntax, parser.cursor, "expected a colon after object key")
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
			return nil, parseFail(ErrorSyntax, parser.cursor, "expected a comma or closing object brace")
		}
		parser.skipWhitespace()
		if parser.cursor < len(parser.input) && parser.input[parser.cursor] == '}' {
			return nil, parseFail(ErrorSyntax, parser.cursor, "trailing commas are not valid JSON")
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
			return nil, parseFail(ErrorSyntax, parser.cursor, "expected a comma or closing array bracket")
		}
		parser.skipWhitespace()
		if parser.cursor < len(parser.input) && parser.input[parser.cursor] == ']' {
			return nil, parseFail(ErrorSyntax, parser.cursor, "trailing commas are not valid JSON")
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
			buffer = append(buffer, escaped...)
			length += units
		default:
			if current <= 0x1f {
				return nil, parseFail(ErrorSyntax, parser.cursor-1, "unescaped control character")
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
			return nil, parseFail(ErrorLimit, parser.cursor, "JSON string exceeds its limit")
		}
	}
	return nil, parseFail(ErrorSyntax, start, "unterminated JSON string")
}

func (parser *parser) escape(_ int) ([]byte, int, error) {
	if parser.cursor >= len(parser.input) {
		return nil, 0, parseFail(ErrorSyntax, parser.cursor, "incomplete escape sequence")
	}
	escaped := parser.input[parser.cursor]
	parser.cursor++
	switch escaped {
	case '"', '\\', '/':
		return []byte{escaped}, 1, nil
	case 'b':
		return []byte{'\b'}, 1, nil
	case 'f':
		return []byte{'\f'}, 1, nil
	case 'n':
		return []byte{'\n'}, 1, nil
	case 'r':
		return []byte{'\r'}, 1, nil
	case 't':
		return []byte{'\t'}, 1, nil
	case 'u':
		first, err := parser.hexCodeUnit()
		if err != nil {
			return nil, 0, err
		}
		if first < 0xd800 || first > 0xdfff {
			return utf8.AppendRune(nil, rune(first)), 1, nil
		}
		if first >= 0xdc00 {
			return AppendWTF8CodeUnit(nil, first), 1, nil
		}
		if parser.cursor+6 <= len(parser.input) && parser.input[parser.cursor] == '\\' && parser.input[parser.cursor+1] == 'u' {
			secondCursor := parser.cursor + 2
			second, valid := decodeHexCodeUnit(parser.input[secondCursor : secondCursor+4])
			if valid && second >= 0xdc00 && second <= 0xdfff {
				parser.cursor += 6
				return utf8.AppendRune(nil, utf16.DecodeRune(rune(first), rune(second))), 2, nil
			}
		}
		return AppendWTF8CodeUnit(nil, first), 1, nil
	default:
		return nil, 0, parseFail(ErrorSyntax, parser.cursor-1, "invalid escape sequence")
	}
}

func decodeHexCodeUnit(value []byte) (uint16, bool) {
	if len(value) != 4 {
		return 0, false
	}
	var result uint16
	for _, current := range value {
		result <<= 4
		switch {
		case current >= '0' && current <= '9':
			result += uint16(current - '0')
		case current >= 'a' && current <= 'f':
			result += uint16(current-'a') + 10
		case current >= 'A' && current <= 'F':
			result += uint16(current-'A') + 10
		default:
			return 0, false
		}
	}
	return result, true
}

func (parser *parser) hexCodeUnit() (uint16, error) {
	if parser.cursor+4 > len(parser.input) {
		return 0, parseFail(ErrorSyntax, parser.cursor, "incomplete Unicode escape")
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
			return 0, parseFail(ErrorSyntax, parser.cursor+index, "invalid Unicode escape")
		}
	}
	parser.cursor += 4
	return result, nil
}

func (parser *parser) number() (Value, error) {
	start := parser.cursor
	if parser.consume('-') && parser.cursor >= len(parser.input) {
		return nil, parseFail(ErrorSyntax, start, "invalid JSON number")
	}
	if parser.consume('0') {
		if parser.cursor < len(parser.input) && parser.input[parser.cursor] >= '0' && parser.input[parser.cursor] <= '9' {
			return nil, parseFail(ErrorSyntax, parser.cursor, "leading zero in JSON number")
		}
	} else if !parser.digits(true) {
		return nil, parseFail(ErrorSyntax, start, "invalid JSON number")
	}
	if parser.consume('.') && !parser.digits(true) {
		return nil, parseFail(ErrorSyntax, parser.cursor, "fraction requires digits")
	}
	if parser.cursor < len(parser.input) && (parser.input[parser.cursor] == 'e' || parser.input[parser.cursor] == 'E') {
		parser.cursor++
		if parser.cursor < len(parser.input) && (parser.input[parser.cursor] == '+' || parser.input[parser.cursor] == '-') {
			parser.cursor++
		}
		if !parser.digits(true) {
			return nil, parseFail(ErrorSyntax, parser.cursor, "exponent requires digits")
		}
	}
	value, err := strconv.ParseFloat(string(parser.input[start:parser.cursor]), 64)
	if err != nil || math.IsInf(value, 0) || math.IsNaN(value) {
		return nil, parseFail(ErrorSyntax, start, "number is outside finite binary64 range")
	}
	return value, nil
}

func (parser *parser) digits(required bool) bool {
	start := parser.cursor
	for parser.cursor < len(parser.input) && parser.input[parser.cursor] >= '0' && parser.input[parser.cursor] <= '9' {
		parser.cursor++
	}
	return !required || parser.cursor > start
}

func (parser *parser) literal(token string, value Value) (Value, error) {
	if parser.cursor+len(token) > len(parser.input) || string(parser.input[parser.cursor:parser.cursor+len(token)]) != token {
		return nil, parseFail(ErrorSyntax, parser.cursor, "invalid JSON literal")
	}
	parser.cursor += len(token)
	return value, nil
}

func (parser *parser) skipWhitespace() {
	for parser.cursor < len(parser.input) {
		switch parser.input[parser.cursor] {
		case ' ', '\t', '\n', '\r':
			parser.cursor++
		default:
			return
		}
	}
}

func (parser *parser) consume(value byte) bool {
	if parser.cursor < len(parser.input) && parser.input[parser.cursor] == value {
		parser.cursor++
		return true
	}
	return false
}
