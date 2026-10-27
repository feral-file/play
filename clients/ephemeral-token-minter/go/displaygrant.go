package minter

import (
	"bytes"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"
)

// ErrInvalidDisplayGrant wraps every ParseDisplayGrantKeys failure, so the host
// can map it to one refusal without matching messages.
var ErrInvalidDisplayGrant = errors.New("invalid display grant keys")

// DisplayGrantKeys are the browser's display-grant public keys, read from the
// raw MintRequest.DisplayGrant by ParseDisplayGrantKeys. SigJWK and EncJWK are
// the canonical {kty, crv, x, y} forms of the keys the browser sent.
type DisplayGrantKeys struct {
	Sig    *ecdsa.PublicKey
	Enc    *ecdh.PublicKey
	SigJWK PublicJWK
	EncJWK PublicJWK
}

// DisplayGrantResult is the display grant a device issues to a requester that
// sent display-grant keys. It travels only inside the encrypted mint_succeeded
// payload, as its top-level displayGrant member.
//
// Version and Profile.Version must be 1. Profile.Sig and Profile.Enc are the
// device's public JWKs, passed through as given. ExpiresAt is an RFC 3339 time;
// empty means the owner kept the grant and it never expires.
type DisplayGrantResult struct {
	Version         int                 `json:"v"`
	Ctl             string              `json:"ctl"`
	Profile         DisplayGrantProfile `json:"profile"`
	RelayV2Endpoint string              `json:"relayV2Endpoint"`
	ExpiresAt       string              `json:"expiresAt,omitempty"`
}

// DisplayGrantProfile is the device profile a display grant pins: the device
// id, its identity generation and its public signing and encryption JWKs.
type DisplayGrantProfile struct {
	Version int             `json:"v"`
	Dev     string          `json:"dev"`
	Gen     string          `json:"gen"`
	Sig     json.RawMessage `json:"sig"`
	Enc     json.RawMessage `json:"enc"`
}

func (grant DisplayGrantResult) validate() error {
	if grant.Version != 1 {
		return fmt.Errorf("display grant version must be 1, got %d", grant.Version)
	}
	if grant.Ctl == "" || grant.RelayV2Endpoint == "" {
		return errors.New("display grant ctl and relayV2Endpoint are required")
	}
	profile := grant.Profile
	if profile.Version != 1 {
		return fmt.Errorf("display grant profile version must be 1, got %d", profile.Version)
	}
	if profile.Dev == "" || profile.Gen == "" {
		return errors.New("display grant profile dev and gen are required")
	}
	if !json.Valid(profile.Sig) || !json.Valid(profile.Enc) {
		return errors.New("display grant profile sig and enc must be JSON values")
	}
	if grant.ExpiresAt != "" {
		if _, err := time.Parse(time.RFC3339, grant.ExpiresAt); err != nil {
			return errors.New("display grant expiresAt must be an RFC 3339 time")
		}
	}
	return nil
}

// ParseDisplayGrantKeys validates a requester's raw displayGrant member,
// {"v":1,"sig":<JWK>,"enc":<JWK>}, and returns its keys. Each JWK must be a
// P-256 public EC key with exactly the members kty, crv, x and y: a private
// "d", WebCrypto's "ext"/"key_ops", or any other member is refused, as is a
// point off the curve. Unknown or repeated top-level members are refused too.
// Hosts compare the parsed keys or the canonical SigJWK/EncJWK, never the raw
// member bytes.
//
// PollMintRequest and JoinedMintRequest never call this: they pass the member
// through raw, so a malformed one never fails a poll or a join. The host calls
// it when it decides whether to issue a grant.
func ParseDisplayGrantKeys(raw json.RawMessage) (DisplayGrantKeys, error) {
	members, err := strictObject(raw, "v", "sig", "enc")
	if err != nil {
		return DisplayGrantKeys{}, fmt.Errorf("%w: %v", ErrInvalidDisplayGrant, err)
	}
	if string(members["v"]) != "1" {
		return DisplayGrantKeys{}, fmt.Errorf("%w: v must be 1", ErrInvalidDisplayGrant)
	}
	sigJWK, sigRaw, err := parseStrictP256JWK(members["sig"])
	if err != nil {
		return DisplayGrantKeys{}, fmt.Errorf("%w: sig: %v", ErrInvalidDisplayGrant, err)
	}
	encJWK, encRaw, err := parseStrictP256JWK(members["enc"])
	if err != nil {
		return DisplayGrantKeys{}, fmt.Errorf("%w: enc: %v", ErrInvalidDisplayGrant, err)
	}
	sig, err := ecdsa.ParseUncompressedPublicKey(elliptic.P256(), sigRaw)
	if err != nil {
		return DisplayGrantKeys{}, fmt.Errorf("%w: sig: %v", ErrInvalidDisplayGrant, err)
	}
	enc, err := ecdh.P256().NewPublicKey(encRaw)
	if err != nil {
		return DisplayGrantKeys{}, fmt.Errorf("%w: enc: %v", ErrInvalidDisplayGrant, err)
	}
	return DisplayGrantKeys{Sig: sig, Enc: enc, SigJWK: sigJWK, EncJWK: encJWK}, nil
}

// parseStrictP256JWK reads a {kty:"EC", crv:"P-256", x, y} JWK with no other
// members and returns it with its uncompressed point encoding. Whether the
// point is on the curve is left to the caller's key constructor.
func parseStrictP256JWK(raw json.RawMessage) (PublicJWK, []byte, error) {
	members, err := strictObject(raw, "kty", "crv", "x", "y")
	if err != nil {
		return PublicJWK{}, nil, err
	}
	var jwk PublicJWK
	for name, target := range map[string]*string{"kty": &jwk.KeyType, "crv": &jwk.Curve, "x": &jwk.X, "y": &jwk.Y} {
		if err := json.Unmarshal(members[name], target); err != nil {
			return PublicJWK{}, nil, fmt.Errorf("%s must be a string", name)
		}
	}
	if jwk.KeyType != "EC" || jwk.Curve != "P-256" {
		return PublicJWK{}, nil, fmt.Errorf("unsupported key %s/%s, want EC/P-256", jwk.KeyType, jwk.Curve)
	}
	// Strict base64url: only alphabet bytes (the decoder itself skips \r and
	// \n), no padding and no stray trailing bits, so each key has exactly one
	// accepted spelling.
	if !isBase64URL(jwk.X) || !isBase64URL(jwk.Y) {
		return PublicJWK{}, nil, errors.New("x and y must be unpadded base64url")
	}
	x, err := rawBase64.Strict().DecodeString(jwk.X)
	if err != nil {
		return PublicJWK{}, nil, errors.New("x is not base64url")
	}
	y, err := rawBase64.Strict().DecodeString(jwk.Y)
	if err != nil {
		return PublicJWK{}, nil, errors.New("y is not base64url")
	}
	if len(x) != 32 || len(y) != 32 {
		return PublicJWK{}, nil, errors.New("P-256 coordinates must be 32 bytes")
	}
	point := make([]byte, 0, 65)
	point = append(point, 4)
	point = append(point, x...)
	point = append(point, y...)
	return jwk, point, nil
}

func isBase64URL(value string) bool {
	for i := 0; i < len(value); i++ {
		c := value[i]
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

// strictObject decodes raw as one JSON object whose members are exactly the
// given names, each once, and returns their raw values.
func strictObject(raw json.RawMessage, names ...string) (map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return nil, errors.New("not a JSON object")
	}
	allowed := make(map[string]bool, len(names))
	for _, name := range names {
		allowed[name] = true
	}
	members := make(map[string]json.RawMessage, len(names))
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, errors.New("not a JSON object")
		}
		name, _ := token.(string)
		if !allowed[name] {
			return nil, fmt.Errorf("unexpected member %q", name)
		}
		if _, repeated := members[name]; repeated {
			return nil, fmt.Errorf("repeated member %q", name)
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, errors.New("not a JSON object")
		}
		members[name] = value
	}
	if _, err := decoder.Token(); err != nil {
		return nil, errors.New("not a JSON object")
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, errors.New("trailing data after the JSON object")
	}
	for _, name := range names {
		if _, present := members[name]; !present {
			return nil, fmt.Errorf("missing member %q", name)
		}
	}
	return members, nil
}
