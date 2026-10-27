package minter

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

// testJWK returns a fresh P-256 public key as a strict {kty, crv, x, y} JWK.
func testJWK(t *testing.T) PublicJWK {
	t.Helper()
	key, err := generatePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	jwk, err := publicKeyToJWK(key.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	jwk.Ext = nil
	return jwk
}

func jwkJSON(t *testing.T, jwk PublicJWK) string {
	t.Helper()
	encoded, err := json.Marshal(jwk)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func testDisplayGrantResult() *DisplayGrantResult {
	return &DisplayGrantResult{
		Version: 1,
		Ctl:     "ctl_site",
		Profile: DisplayGrantProfile{
			Version: 1,
			Dev:     "FF1-TEST",
			Gen:     "gen_1",
			Sig:     json.RawMessage(`{"kty":"EC","crv":"P-256","x":"sx","y":"sy"}`),
			Enc:     json.RawMessage(`{"kty":"EC","crv":"P-256","x":"ex","y":"ey"}`),
		},
		RelayV2Endpoint: "wss://relay.example/v2",
		ExpiresAt:       "2026-06-16T11:00:00Z",
	}
}

const testDisplayGrantRequest = `{"v":1,"sig":{"kty":"EC"},"enc":{"kty":"EC"}}`

// The session-only bytes are the ones SendMintSuccess sent before display
// grants existed; old requesters must see no change at all.
func TestSendMintSuccessGoldenBytes(t *testing.T) {
	expiresAt := time.Date(2026, 6, 16, 11, 0, 0, 0, time.UTC)
	timed := MintResult{SessionID: "eps_123", Token: "browser-token-secret", ExpiresAt: expiresAt, RelayerBaseURL: "https://relayer.example"}
	kept := MintResult{SessionID: "eps_kept", Token: "browser-token-secret", Persistent: true}
	const prefix = `{"v":1,"type":"mint_succeeded","channelId":"ch_test","requestMessageId":"msg_browser",`
	const timedSession = `"session":{"sessionId":"eps_123","token":"browser-token-secret","expiresAt":"2026-06-16T11:00:00Z","relayerBaseUrl":"https://relayer.example"}`
	const grant = `"displayGrant":{"v":1,"ctl":"ctl_site","profile":{"v":1,"dev":"FF1-TEST","gen":"gen_1","sig":{"kty":"EC","crv":"P-256","x":"sx","y":"sy"},"enc":{"kty":"EC","crv":"P-256","x":"ex","y":"ey"}},"relayV2Endpoint":"wss://relay.example/v2","expiresAt":"2026-06-16T11:00:00Z"}`
	keptGrant := testDisplayGrantResult()
	keptGrant.ExpiresAt = ""

	tests := []struct {
		name       string
		send       func(*channelHarness, MintRequest) error
		want       string
		grantKeys  bool
		persistent bool
	}{
		{
			name: "session-only timed, legacy signature",
			send: func(h *channelHarness, r MintRequest) error {
				_, err := h.channel.SendMintSuccess(context.Background(), r, timed)
				return err
			},
			want: prefix + timedSession + `}`,
		},
		{
			name: "session-only kept, legacy signature",
			send: func(h *channelHarness, r MintRequest) error {
				_, err := h.channel.SendMintSuccess(context.Background(), r, kept)
				return err
			},
			want:       prefix + `"session":{"sessionId":"eps_kept","token":"browser-token-secret","expiresAt":null,"persistent":true}}`,
			persistent: true,
		},
		{
			name: "session-only through SendMintSuccessResult",
			send: func(h *channelHarness, r MintRequest) error {
				_, err := h.channel.SendMintSuccessResult(context.Background(), r, MintSuccess{Session: &timed})
				return err
			},
			want: prefix + timedSession + `}`,
		},
		{
			name: "grant-only",
			send: func(h *channelHarness, r MintRequest) error {
				_, err := h.channel.SendMintSuccessResult(context.Background(), r, MintSuccess{DisplayGrant: testDisplayGrantResult()})
				return err
			},
			want:      prefix + grant + `}`,
			grantKeys: true,
		},
		{
			name: "grant-only kept omits expiresAt",
			send: func(h *channelHarness, r MintRequest) error {
				_, err := h.channel.SendMintSuccessResult(context.Background(), r, MintSuccess{DisplayGrant: keptGrant})
				return err
			},
			want:      prefix + strings.Replace(grant, `,"expiresAt":"2026-06-16T11:00:00Z"`, "", 1) + `}`,
			grantKeys: true,
		},
		{
			name: "session and grant",
			send: func(h *channelHarness, r MintRequest) error {
				_, err := h.channel.SendMintSuccessResult(context.Background(), r, MintSuccess{Session: &timed, DisplayGrant: testDisplayGrantResult()})
				return err
			},
			want:      prefix + timedSession + `,` + grant + `}`,
			grantKeys: true,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			h := newChannelHarness(t)
			request := h.mintRequest(t)
			request.SupportsPersistentSessions = test.persistent
			if test.grantKeys {
				request.DisplayGrant = json.RawMessage(testDisplayGrantRequest)
			}
			if err := test.send(h, request); err != nil {
				t.Fatal(err)
			}
			if got := string(h.decryptMinterMessage(t, h.sentMessages[0])); got != test.want {
				t.Fatalf("plaintext\n got %s\nwant %s", got, test.want)
			}
		})
	}
}

func TestSendMintSuccessResultRefusals(t *testing.T) {
	session := &MintResult{SessionID: "eps_123", Token: "tok", ExpiresAt: time.Now().Add(time.Hour)}
	mutate := func(edit func(*DisplayGrantResult)) *DisplayGrantResult {
		grant := testDisplayGrantResult()
		edit(grant)
		return grant
	}
	tests := map[string]struct {
		success   MintSuccess
		grantKeys bool
	}{
		"neither":                {success: MintSuccess{}, grantKeys: true},
		"grant without keys":     {success: MintSuccess{DisplayGrant: testDisplayGrantResult()}},
		"both without keys":      {success: MintSuccess{Session: session, DisplayGrant: testDisplayGrantResult()}},
		"session without token":  {success: MintSuccess{Session: &MintResult{ExpiresAt: time.Now()}}, grantKeys: true},
		"grant version":          {success: MintSuccess{DisplayGrant: mutate(func(g *DisplayGrantResult) { g.Version = 2 })}, grantKeys: true},
		"profile version":        {success: MintSuccess{DisplayGrant: mutate(func(g *DisplayGrantResult) { g.Profile.Version = 0 })}, grantKeys: true},
		"missing ctl":            {success: MintSuccess{DisplayGrant: mutate(func(g *DisplayGrantResult) { g.Ctl = "" })}, grantKeys: true},
		"missing relay endpoint": {success: MintSuccess{DisplayGrant: mutate(func(g *DisplayGrantResult) { g.RelayV2Endpoint = "" })}, grantKeys: true},
		"missing dev":            {success: MintSuccess{DisplayGrant: mutate(func(g *DisplayGrantResult) { g.Profile.Dev = "" })}, grantKeys: true},
		"missing profile sig":    {success: MintSuccess{DisplayGrant: mutate(func(g *DisplayGrantResult) { g.Profile.Sig = nil })}, grantKeys: true},
		"expiresAt not RFC 3339": {success: MintSuccess{DisplayGrant: mutate(func(g *DisplayGrantResult) { g.ExpiresAt = "tomorrow" })}, grantKeys: true},
		"grant with bad session": {success: MintSuccess{Session: &MintResult{Token: "tok"}, DisplayGrant: testDisplayGrantResult()}, grantKeys: true},
		"persistent unsupported": {success: MintSuccess{Session: &MintResult{Token: "tok", Persistent: true}}, grantKeys: true},
	}
	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			h := newChannelHarness(t)
			request := h.mintRequest(t)
			if test.grantKeys {
				request.DisplayGrant = json.RawMessage(testDisplayGrantRequest)
			}
			if _, err := h.channel.SendMintSuccessResult(context.Background(), request, test.success); err == nil {
				t.Fatal("expected a refusal")
			}
			if len(h.sentMessages) != 0 {
				t.Fatal("a refused result reached the broker")
			}
		})
	}
}

func TestMintResultJSONHasNoDisplayGrant(t *testing.T) {
	encoded, err := json.Marshal(MintResult{SessionID: "eps", Token: "tok", Persistent: true})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "displayGrant") {
		t.Fatalf("MintResult JSON carries a display grant: %s", encoded)
	}
}

// Any JSON value in displayGrant reaches the host raw; none fails the poll.
func TestPollMintRequestPassesDisplayGrantThroughRaw(t *testing.T) {
	cases := map[string]string{
		"absent":         "",
		"valid shape":    testDisplayGrantRequest,
		"string":         `"not-an-object"`,
		"array":          `[1,2]`,
		"wrong version":  `{"v":9}`,
		"private key":    `{"v":1,"sig":{"kty":"EC","crv":"P-256","x":"a","y":"b","d":"secret"},"enc":{}}`,
		"unknown member": `{"v":1,"extra":true}`,
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			h := newChannelHarness(t)
			plaintext := h.validMintRequestPlaintext("msg_browser")
			plaintext.DisplayGrant = json.RawMessage(raw)
			h.messages = []encryptedMessage{h.encryptBrowserMessage(t, "msg_browser", 1, plaintext)}
			request, err := h.channel.PollMintRequest(context.Background(), 0)
			if err != nil || request == nil {
				t.Fatalf("poll = %#v, %v", request, err)
			}
			if string(request.DisplayGrant) != raw {
				t.Fatalf("DisplayGrant = %q, want %q", request.DisplayGrant, raw)
			}
		})
	}
}

// A null displayGrant is not sent: the request is a 0.4 request.
func TestDisplayGrantNullIsAbsent(t *testing.T) {
	h := newChannelHarness(t)
	plaintext := h.validMintRequestPlaintext("msg_browser")
	plaintext.DisplayGrant = json.RawMessage(`null`)
	h.messages = []encryptedMessage{h.encryptBrowserMessage(t, "msg_browser", 1, plaintext)}
	request, err := h.channel.PollMintRequest(context.Background(), 0)
	if err != nil || request == nil || request.DisplayGrant != nil {
		t.Fatalf("poll = %#v, %v; want nil DisplayGrant", request, err)
	}

	j := newJoinHarness(t)
	j.createMetadata = json.RawMessage(`{"v":1,"requestMessageId":"msg_site","displayGrant":null}`)
	channel := j.join(t, JoinChannelOptions{ChannelID: "ch_site", PairingToken: "pt_secret"})
	joined, ok := channel.JoinedMintRequest()
	if !ok || joined.DisplayGrant != nil {
		t.Fatalf("joined = %#v, %t; want nil DisplayGrant", joined, ok)
	}
}

func TestJoinedMintRequestPassesDisplayGrantThroughRaw(t *testing.T) {
	for _, raw := range []string{testDisplayGrantRequest, `"garbage"`, `{"v":1,"sig":{"d":"x"}}`} {
		h := newJoinHarness(t)
		h.createMetadata = json.RawMessage(`{"v":1,"requestMessageId":"msg_site","displayGrant":` + raw + `}`)
		channel := h.join(t, JoinChannelOptions{ChannelID: "ch_site", PairingToken: "pt_secret"})
		request, ok := channel.JoinedMintRequest()
		if !ok {
			t.Fatalf("displayGrant %s dropped the joined request", raw)
		}
		if string(request.DisplayGrant) != raw {
			t.Fatalf("DisplayGrant = %q, want %q", request.DisplayGrant, raw)
		}
	}

	h := newJoinHarness(t)
	h.createMetadata = json.RawMessage(`{"v":1,"requestMessageId":"msg_site"}`)
	channel := h.join(t, JoinChannelOptions{ChannelID: "ch_site", PairingToken: "pt_secret"})
	if request, _ := channel.JoinedMintRequest(); request.DisplayGrant != nil {
		t.Fatalf("a 0.4 request carries DisplayGrant %q", request.DisplayGrant)
	}
}

func TestParseDisplayGrantKeys(t *testing.T) {
	sig := testJWK(t)
	enc := testJWK(t)
	valid := `{"v":1,"sig":` + jwkJSON(t, sig) + `,"enc":` + jwkJSON(t, enc) + `}`

	keys, err := ParseDisplayGrantKeys(json.RawMessage(valid))
	if err != nil {
		t.Fatal(err)
	}
	if keys.Sig == nil || keys.Enc == nil || keys.SigJWK != sig || keys.EncJWK != enc {
		t.Fatalf("keys = %#v", keys)
	}
	sigRaw, err := keys.Sig.Bytes()
	if err != nil {
		t.Fatal(err)
	}
	if rawBase64.EncodeToString(sigRaw[1:33]) != sig.X {
		t.Fatal("sig key does not carry the sent point")
	}

	withMember := func(jwk PublicJWK, member string) string {
		return strings.TrimSuffix(jwkJSON(t, jwk), "}") + `,` + member + `}`
	}
	offCurve := sig
	offCurve.Y = rawBase64.EncodeToString(make([]byte, 32))
	padded := sig
	padded.X += "="
	short := sig
	short.X = rawBase64.EncodeToString(make([]byte, 31))
	newline := sig
	newline.X = sig.X[:10] + "\n" + sig.X[10:]
	wrongCurve := sig
	wrongCurve.Curve = "P-384"
	wrongType := sig
	wrongType.KeyType = "OKP"

	rejects := map[string]string{
		"empty":                 ``,
		"not an object":         `[]`,
		"null":                  `null`,
		"trailing data":         valid + `{}`,
		"missing v":             `{"sig":` + jwkJSON(t, sig) + `,"enc":` + jwkJSON(t, enc) + `}`,
		"v 2":                   `{"v":2,"sig":` + jwkJSON(t, sig) + `,"enc":` + jwkJSON(t, enc) + `}`,
		"v string":              `{"v":"1","sig":` + jwkJSON(t, sig) + `,"enc":` + jwkJSON(t, enc) + `}`,
		"missing enc":           `{"v":1,"sig":` + jwkJSON(t, sig) + `}`,
		"extra top-level":       `{"v":1,"sig":` + jwkJSON(t, sig) + `,"enc":` + jwkJSON(t, enc) + `,"x":1}`,
		"repeated top-level":    `{"v":1,"sig":` + jwkJSON(t, sig) + `,"sig":` + jwkJSON(t, sig) + `,"enc":` + jwkJSON(t, enc) + `}`,
		"private d":             `{"v":1,"sig":` + withMember(sig, `"d":"AAAA"`) + `,"enc":` + jwkJSON(t, enc) + `}`,
		"webcrypto ext":         `{"v":1,"sig":` + jwkJSON(t, sig) + `,"enc":` + withMember(enc, `"ext":true`) + `}`,
		"webcrypto key_ops":     `{"v":1,"sig":` + withMember(sig, `"key_ops":["verify"]`) + `,"enc":` + jwkJSON(t, enc) + `}`,
		"repeated jwk member":   `{"v":1,"sig":` + withMember(sig, `"x":"`+sig.X+`"`) + `,"enc":` + jwkJSON(t, enc) + `}`,
		"missing y":             `{"v":1,"sig":{"kty":"EC","crv":"P-256","x":"` + sig.X + `"},"enc":` + jwkJSON(t, enc) + `}`,
		"wrong crv":             `{"v":1,"sig":` + jwkJSON(t, wrongCurve) + `,"enc":` + jwkJSON(t, enc) + `}`,
		"wrong kty":             `{"v":1,"sig":` + jwkJSON(t, sig) + `,"enc":` + jwkJSON(t, wrongType) + `}`,
		"off-curve sig":         `{"v":1,"sig":` + jwkJSON(t, offCurve) + `,"enc":` + jwkJSON(t, enc) + `}`,
		"off-curve enc":         `{"v":1,"sig":` + jwkJSON(t, sig) + `,"enc":` + jwkJSON(t, offCurve) + `}`,
		"padded base64":         `{"v":1,"sig":` + jwkJSON(t, padded) + `,"enc":` + jwkJSON(t, enc) + `}`,
		"embedded newline":      `{"v":1,"sig":` + jwkJSON(t, newline) + `,"enc":` + jwkJSON(t, enc) + `}`,
		"short coordinate":      `{"v":1,"sig":` + jwkJSON(t, short) + `,"enc":` + jwkJSON(t, enc) + `}`,
		"coordinate not string": `{"v":1,"sig":{"kty":"EC","crv":"P-256","x":1,"y":"` + sig.Y + `"},"enc":` + jwkJSON(t, enc) + `}`,
	}
	for name, raw := range rejects {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseDisplayGrantKeys(json.RawMessage(raw)); !errors.Is(err, ErrInvalidDisplayGrant) {
				t.Fatalf("err = %v, want ErrInvalidDisplayGrant", err)
			}
		})
	}
}
