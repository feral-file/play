package minter

import (
	"context"
	"crypto/ecdh"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestCryptoRoundTrip(t *testing.T) {
	minterKey, err := generatePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	browserKey, err := generatePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	minterJWK, err := publicKeyToJWK(minterKey.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	browserJWK, err := publicKeyToJWK(browserKey.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	aad := envelopeAAD{
		Version:   1,
		ChannelID: "ch_test",
		MessageID: "msg_test",
		Seq:       0,
		Sender:    "browser",
		Recipient: "minter",
		Algorithm: Algorithm,
	}
	encrypted, err := encryptJSON(browserKey, minterJWK, aad, mintRequestPlaintext{
		Version:             1,
		Type:                messageTypeMintRequest,
		ChannelID:           "ch_test",
		RequestMessageID:    "msg_test",
		Origin:              "https://nft.example",
		BrowserPublicKeyJWK: browserJWK,
	})
	if err != nil {
		t.Fatal(err)
	}
	encrypted.SenderPublicKeyJWK = &browserJWK
	plaintext, decodedAAD, err := decryptMessage(minterKey, encrypted, browserJWK)
	if err != nil {
		t.Fatal(err)
	}
	if decodedAAD.ChannelID != "ch_test" {
		t.Fatalf("channel binding mismatch: %s", decodedAAD.ChannelID)
	}
	var decoded mintRequestPlaintext
	if err := json.Unmarshal(plaintext, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Type != messageTypeMintRequest || decoded.Origin != "https://nft.example" {
		t.Fatalf("unexpected plaintext: %#v", decoded)
	}
}

func TestStartChannelParsesBrokerResponse(t *testing.T) {
	expiresAt := time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/channels" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		rawBody := readRequestBody(t, r)
		if strings.Contains(rawBody, "topic-1") || strings.Contains(rawBody, "topicId") {
			t.Fatalf("topic context leaked to broker create request: %s", rawBody)
		}
		var request createChannelRequest
		if err := json.Unmarshal([]byte(rawBody), &request); err != nil {
			t.Fatal(err)
		}
		if request.Algorithm != Algorithm {
			t.Fatalf("unexpected algorithm: %s", request.Algorithm)
		}
		if request.MinterPublicKeyJWK.Curve != "P-256" {
			t.Fatalf("unexpected key: %#v", request.MinterPublicKeyJWK)
		}
		if request.IdleTTLSeconds != 300 || !request.ShortCodeRequested {
			t.Fatalf("unexpected create request: %#v", request)
		}
		writeJSON(t, w, createChannelResponse{
			ChannelID:   "ch_123",
			MinterToken: "mt_secret",
			ShortCode:   "123456",
			ExpiresAt:   expiresAt,
			QRPayload:   json.RawMessage(`{"v":1,"type":"ff-mint-pairing"}`),
		})
	}))
	defer server.Close()

	channel, err := NewClient(server.Client()).StartChannel(context.Background(), StartChannelOptions{
		BrokerBaseURL:      server.URL,
		IdleTTL:            5 * time.Minute,
		ShortCodeRequested: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	display := channel.PairingDisplay()
	if display.ChannelID != "ch_123" || display.ShortCode != "123456" || !display.ExpiresAt.Equal(expiresAt) {
		t.Fatalf("unexpected display: %#v", display)
	}
	if string(display.QRPayload) != `{"v":1,"type":"ff-mint-pairing"}` {
		t.Fatalf("unexpected QR payload: %s", display.QRPayload)
	}
}

func TestPollMintRequestDecryptsBrowserMessage(t *testing.T) {
	harness := newChannelHarness(t)
	requestPlaintext := mintRequestPlaintext{
		Version:          1,
		Type:             messageTypeMintRequest,
		ChannelID:        "ch_test",
		RequestMessageID: "msg_browser",
		Origin:           "https://nft.example",
		BrowserInfo: BrowserInfo{
			Name:      "Chrome",
			UserAgent: "Mozilla/5.0",
			Label:     "Gallery laptop",
		},
		BrowserPublicKeyJWK:       harness.browserJWK,
		RequestedExpiresInSeconds: json.Number("900"),
	}
	message := harness.encryptBrowserMessage(t, "msg_browser", 7, requestPlaintext)
	harness.messages = []encryptedMessage{message}

	request, err := harness.channel.PollMintRequest(context.Background(), 6)
	if err != nil {
		t.Fatal(err)
	}
	if request == nil {
		t.Fatal("expected mint request")
	}
	if request.ChannelID != "ch_test" || request.MessageID != "msg_browser" || request.Seq != 7 {
		t.Fatalf("unexpected request binding: %#v", request)
	}
	if request.Origin != "https://nft.example" || request.BrowserInfo.Name != "Chrome" || request.RequestedExpiresInSeconds != 900 {
		t.Fatalf("unexpected request payload: %#v", request)
	}
}

func TestPollMintRequestRejectsInvalidPlaintextBindings(t *testing.T) {
	testCases := []struct {
		name      string
		plaintext func(*channelHarness) mintRequestPlaintext
		messageID string
	}{
		{
			name: "missing version",
			plaintext: func(h *channelHarness) mintRequestPlaintext {
				plaintext := h.validMintRequestPlaintext("msg_browser")
				plaintext.Version = 0
				return plaintext
			},
			messageID: "msg_browser",
		},
		{
			name: "channel mismatch",
			plaintext: func(h *channelHarness) mintRequestPlaintext {
				plaintext := h.validMintRequestPlaintext("msg_browser")
				plaintext.ChannelID = "ch_other"
				return plaintext
			},
			messageID: "msg_browser",
		},
		{
			name: "request message id mismatch",
			plaintext: func(h *channelHarness) mintRequestPlaintext {
				plaintext := h.validMintRequestPlaintext("msg_browser")
				plaintext.RequestMessageID = "msg_other"
				return plaintext
			},
			messageID: "msg_browser",
		},
		{
			name: "browser key mismatch",
			plaintext: func(h *channelHarness) mintRequestPlaintext {
				otherKey, err := generatePrivateKey()
				if err != nil {
					h.t.Fatal(err)
				}
				otherJWK, err := publicKeyToJWK(otherKey.PublicKey())
				if err != nil {
					h.t.Fatal(err)
				}
				plaintext := h.validMintRequestPlaintext("msg_browser")
				plaintext.BrowserPublicKeyJWK = otherJWK
				return plaintext
			},
			messageID: "msg_browser",
		},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			harness := newChannelHarness(t)
			harness.messages = []encryptedMessage{
				harness.encryptBrowserMessage(t, testCase.messageID, 7, testCase.plaintext(harness)),
			}

			request, err := harness.channel.PollMintRequest(context.Background(), 6)
			if err == nil {
				t.Fatalf("expected validation error, got request %#v", request)
			}
		})
	}
}

func TestPollMintRequestRejectsInvalidOrigins(t *testing.T) {
	invalidOrigins := []string{
		"",
		"nft.example",
		"ftp://nft.example",
		"https://nft.example/path",
		"https://nft.example/",
		"https://nft.example?x=1",
		"https://nft.example#fragment",
		"https://user:pass@nft.example",
	}
	for _, origin := range invalidOrigins {
		t.Run(origin, func(t *testing.T) {
			harness := newChannelHarness(t)
			plaintext := harness.validMintRequestPlaintext("msg_browser")
			plaintext.Origin = origin
			harness.messages = []encryptedMessage{
				harness.encryptBrowserMessage(t, "msg_browser", 7, plaintext),
			}

			request, err := harness.channel.PollMintRequest(context.Background(), 6)
			if err == nil {
				t.Fatalf("expected invalid origin error, got request %#v", request)
			}
		})
	}
}

func TestSendMintSuccessAndRejectionEncryptPayloads(t *testing.T) {
	harness := newChannelHarness(t)
	request := harness.mintRequest(t)
	expiresAt := time.Date(2026, 6, 16, 11, 0, 0, 0, time.UTC)

	result, err := harness.channel.SendMintSuccess(context.Background(), request, MintResult{
		SessionID:      "eps_123",
		Token:          "browser-token-secret",
		ExpiresAt:      expiresAt,
		RelayerBaseURL: "https://relayer.example",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Seq != 100 {
		t.Fatalf("unexpected send result: %#v", result)
	}
	if harness.closed {
		t.Fatal("terminal send should not close before browser can poll the result")
	}
	if len(harness.sentMessages) != 1 {
		t.Fatalf("expected one sent message, got %d", len(harness.sentMessages))
	}
	if strings.Contains(harness.sentBodies[0], "browser-token-secret") {
		t.Fatal("raw token appeared in broker-visible request body")
	}
	successPlaintext := harness.decryptMinterMessage(t, harness.sentMessages[0])
	var success mintSuccessPlaintext
	if err := json.Unmarshal(successPlaintext, &success); err != nil {
		t.Fatal(err)
	}
	if success.Type != messageTypeMintSucceeded || success.ChannelID != "ch_test" || success.Session.Token != "browser-token-secret" || success.Session.SessionID != "eps_123" {
		t.Fatalf("unexpected success plaintext: %#v", success)
	}

	_, err = harness.channel.SendMintRejection(context.Background(), request, MintRejection{
		Reason:    "rejected_by_user",
		Retryable: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if harness.closed {
		t.Fatal("terminal send should not close before browser can poll the result")
	}
	rejectionPlaintext := harness.decryptMinterMessage(t, harness.sentMessages[1])
	var rejection mintRejectionPlaintext
	if err := json.Unmarshal(rejectionPlaintext, &rejection); err != nil {
		t.Fatal(err)
	}
	if rejection.Type != messageTypeMintRejected || rejection.ChannelID != "ch_test" || rejection.Reason != "rejected_by_user" || !rejection.Retryable {
		t.Fatalf("unexpected rejection plaintext: %#v", rejection)
	}
}

func TestPollMintRequestValidatesRequestedExpiresInSeconds(t *testing.T) {
	testCases := []struct {
		name      string
		requested json.Number
		want      int
		wantError bool
	}{
		{name: "absent lets the host choose", requested: "", want: 0},
		{name: "one second", requested: "1", want: 1},
		{name: "one year", requested: json.Number(strconv.Itoa(MaxRequestedExpiresInSeconds)), want: MaxRequestedExpiresInSeconds},
		{name: "zero", requested: "0", wantError: true},
		{name: "negative", requested: "-1", wantError: true},
		{name: "over one year", requested: json.Number(strconv.Itoa(MaxRequestedExpiresInSeconds + 1)), wantError: true},
		{name: "exponent", requested: "1e+21", wantError: true},
		{name: "fractional", requested: "1.5", wantError: true},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			harness := newChannelHarness(t)
			plaintext := harness.validMintRequestPlaintext("msg_browser")
			plaintext.RequestedExpiresInSeconds = testCase.requested
			harness.messages = []encryptedMessage{harness.encryptBrowserMessage(t, "msg_browser", 7, plaintext)}

			request, err := harness.channel.PollMintRequest(context.Background(), 6)
			if testCase.wantError {
				if err == nil {
					t.Fatalf("expected an error, got request %#v", request)
				}
				if !strings.Contains(err.Error(), "requestedExpiresInSeconds") {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if request == nil || request.RequestedExpiresInSeconds != testCase.want {
				t.Fatalf("unexpected request: %#v", request)
			}
		})
	}
}

func TestSendMintSuccessSessionExpiryShape(t *testing.T) {
	expiresAt := time.Date(2026, 6, 16, 11, 0, 0, 0, time.UTC)
	tests := []struct {
		name           string
		result         MintResult
		wantExpiresAt  any
		wantPersistent bool
	}{
		{
			name:          "timed session keeps its expiry",
			result:        MintResult{SessionID: "eps_timed", Token: "browser-token-secret", ExpiresAt: expiresAt, RelayerBaseURL: "https://relayer.example"},
			wantExpiresAt: "2026-06-16T11:00:00Z",
		},
		{
			name:           "owner-kept session has a null expiry",
			result:         MintResult{SessionID: "eps_kept", Token: "browser-token-secret", Persistent: true, RelayerBaseURL: "https://relayer.example"},
			wantExpiresAt:  nil,
			wantPersistent: true,
		},
		{
			name:           "owner-kept session ignores a set expiry",
			result:         MintResult{SessionID: "eps_kept", Token: "browser-token-secret", ExpiresAt: expiresAt, Persistent: true},
			wantExpiresAt:  nil,
			wantPersistent: true,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			harness := newChannelHarness(t)
			request := harness.mintRequest(t)
			request.SupportsPersistentSessions = true
			if _, err := harness.channel.SendMintSuccess(context.Background(), request, test.result); err != nil {
				t.Fatal(err)
			}
			plaintext := harness.decryptMinterMessage(t, harness.sentMessages[0])
			if strings.Contains(string(plaintext), "0001-01-01") {
				t.Fatalf("zero time serialized into the session payload: %s", plaintext)
			}
			var raw struct {
				Session map[string]any `json:"session"`
			}
			if err := json.Unmarshal(plaintext, &raw); err != nil {
				t.Fatal(err)
			}
			expiresAtValue, present := raw.Session["expiresAt"]
			if !present {
				t.Fatalf("session payload must carry expiresAt: %s", plaintext)
			}
			if expiresAtValue != test.wantExpiresAt {
				t.Fatalf("unexpected expiresAt %#v, want %#v", expiresAtValue, test.wantExpiresAt)
			}
			persistent, _ := raw.Session["persistent"].(bool)
			if persistent != test.wantPersistent {
				t.Fatalf("unexpected persistent %v, want %v", persistent, test.wantPersistent)
			}

			var success mintSuccessPlaintext
			if err := json.Unmarshal(plaintext, &success); err != nil {
				t.Fatal(err)
			}
			if success.Session.Persistent != test.wantPersistent {
				t.Fatalf("unexpected decoded persistent: %#v", success.Session)
			}
			if test.wantPersistent {
				if success.Session.ExpiresAt != nil {
					t.Fatalf("owner-kept session must decode without an expiry: %#v", success.Session)
				}
				return
			}
			if success.Session.ExpiresAt == nil || !success.Session.ExpiresAt.Equal(expiresAt) {
				t.Fatalf("timed session must decode with its expiry: %#v", success.Session)
			}
		})
	}
}

func TestPollMintRequestReadsPersistentSessionSupport(t *testing.T) {
	testCases := []struct {
		name     string
		declared bool
		want     bool
	}{
		{name: "declared", declared: true, want: true},
		{name: "absent reads as incapable", declared: false, want: false},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			harness := newChannelHarness(t)
			plaintext := harness.validMintRequestPlaintext("msg_browser")
			plaintext.SupportsPersistentSessions = testCase.declared
			harness.messages = []encryptedMessage{harness.encryptBrowserMessage(t, "msg_browser", 7, plaintext)}

			request, err := harness.channel.PollMintRequest(context.Background(), 6)
			if err != nil {
				t.Fatal(err)
			}
			if request == nil || request.SupportsPersistentSessions != testCase.want {
				t.Fatalf("unexpected request: %#v", request)
			}
		})
	}
}

func TestSendMintSuccessRefusesPersistentResultForIncapableRequester(t *testing.T) {
	harness := newChannelHarness(t)
	request := harness.mintRequest(t)
	if request.SupportsPersistentSessions {
		t.Fatal("harness request must not declare persistent session support")
	}

	_, err := harness.channel.SendMintSuccess(context.Background(), request, MintResult{
		SessionID:  "eps_kept",
		Token:      "browser-token-secret",
		Persistent: true,
	})
	if err == nil {
		t.Fatal("expected a persistent result to be refused for a requester that did not declare support")
	}
	if !strings.Contains(err.Error(), "supportsPersistentSessions") {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(harness.sentMessages) != 0 {
		t.Fatalf("expected no sent message, got %d", len(harness.sentMessages))
	}

	// The host falls back to a timed session for the same request.
	if _, err := harness.channel.SendMintSuccess(context.Background(), request, MintResult{
		SessionID: "eps_timed",
		Token:     "browser-token-secret",
		ExpiresAt: time.Date(2026, 6, 16, 11, 0, 0, 0, time.UTC),
	}); err != nil {
		t.Fatal(err)
	}
	if len(harness.sentMessages) != 1 {
		t.Fatalf("expected the timed session to be sent, got %d messages", len(harness.sentMessages))
	}
}

func TestSendMintSuccessRequiresExpiryForTimedSession(t *testing.T) {
	harness := newChannelHarness(t)
	request := harness.mintRequest(t)
	_, err := harness.channel.SendMintSuccess(context.Background(), request, MintResult{
		SessionID: "eps_timed",
		Token:     "browser-token-secret",
	})
	if err == nil {
		t.Fatal("expected an error for a timed session without an expiry")
	}
	if len(harness.sentMessages) != 0 {
		t.Fatalf("expected no sent message, got %d", len(harness.sentMessages))
	}
}

func TestMintResultJSONRoundTrip(t *testing.T) {
	expiresAt := time.Date(2026, 6, 16, 11, 0, 0, 0, time.UTC)
	for _, result := range []MintResult{
		{SessionID: "eps_timed", Token: "browser-token-secret", ExpiresAt: expiresAt, RelayerBaseURL: "https://relayer.example"},
		{SessionID: "eps_kept", Token: "browser-token-secret", Persistent: true},
	} {
		encoded, err := json.Marshal(result)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(encoded), "0001-01-01") {
			t.Fatalf("zero time serialized into the session JSON: %s", encoded)
		}
		var decoded MintResult
		if err := json.Unmarshal(encoded, &decoded); err != nil {
			t.Fatal(err)
		}
		if decoded.Persistent != result.Persistent || decoded.SessionID != result.SessionID || !decoded.ExpiresAt.Equal(result.ExpiresAt) {
			t.Fatalf("unexpected round trip %#v from %s", decoded, encoded)
		}
	}
}

func TestCloseSendsDelete(t *testing.T) {
	harness := newChannelHarness(t)
	if err := harness.channel.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !harness.closed {
		t.Fatal("expected broker close request")
	}
}

type channelHarness struct {
	t            *testing.T
	server       *httptest.Server
	channel      *Channel
	browserKey   *ecdh.PrivateKey
	browserJWK   PublicJWK
	messages     []encryptedMessage
	sentMessages []encryptedMessage
	sentBodies   []string
	closed       bool
}

func newChannelHarness(t *testing.T) *channelHarness {
	t.Helper()
	h := &channelHarness{t: t}
	browserKey, err := generatePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	browserJWK, err := publicKeyToJWK(browserKey.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	h.browserKey = browserKey
	h.browserJWK = browserJWK
	h.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/channels":
			writeJSON(t, w, createChannelResponse{
				ChannelID:   "ch_test",
				MinterToken: "mt_test",
				ShortCode:   "654321",
				ExpiresAt:   time.Now().Add(5 * time.Minute).UTC(),
				QRPayload:   json.RawMessage(`{"v":1}`),
			})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/channels/ch_test/messages":
			if r.Header.Get("Authorization") != "Bearer mt_test" {
				t.Fatalf("missing authorization: %s", r.Header.Get("Authorization"))
			}
			if r.URL.Query().Get("afterSeq") == "" {
				t.Fatal("missing afterSeq")
			}
			writeJSON(t, w, pollMessagesResponse{
				ChannelID: "ch_test",
				ExpiresAt: time.Now().Add(5 * time.Minute).UTC(),
				Messages:  h.messages,
			})
		case r.Method == http.MethodPost && r.URL.Path == "/v1/channels/ch_test/messages":
			if r.Header.Get("Authorization") != "Bearer mt_test" {
				t.Fatalf("missing authorization: %s", r.Header.Get("Authorization"))
			}
			var message encryptedMessage
			rawBody := readRequestBody(t, r)
			if err := json.Unmarshal([]byte(rawBody), &message); err != nil {
				t.Fatal(err)
			}
			h.sentBodies = append(h.sentBodies, rawBody)
			h.sentMessages = append(h.sentMessages, message)
			writeJSON(t, w, sendMessageResponse{
				ChannelID: "ch_test",
				Seq:       int64(99 + len(h.sentMessages)),
				ExpiresAt: time.Now().Add(5 * time.Minute).UTC(),
			})
		case r.Method == http.MethodDelete && r.URL.Path == "/v1/channels/ch_test":
			if r.Header.Get("Authorization") != "Bearer mt_test" {
				t.Fatalf("missing authorization: %s", r.Header.Get("Authorization"))
			}
			h.closed = true
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
	}))
	t.Cleanup(h.server.Close)

	channel, err := NewClient(h.server.Client()).StartChannel(context.Background(), StartChannelOptions{
		BrokerBaseURL: h.server.URL,
		IdleTTL:       5 * time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	h.channel = channel
	return h
}

func (h *channelHarness) encryptBrowserMessage(t *testing.T, messageID string, seq int64, plaintext mintRequestPlaintext) encryptedMessage {
	t.Helper()
	aad := envelopeAAD{
		Version:   1,
		ChannelID: h.channel.channelID,
		MessageID: messageID,
		Seq:       seq,
		Sender:    "browser",
		Recipient: "minter",
		Algorithm: Algorithm,
	}
	message, err := encryptJSON(h.browserKey, h.channel.publicKeyJWK, aad, plaintext)
	if err != nil {
		t.Fatal(err)
	}
	message.Seq = seq
	message.SenderPublicKeyJWK = &h.browserJWK
	return message
}

func (h *channelHarness) validMintRequestPlaintext(messageID string) mintRequestPlaintext {
	return mintRequestPlaintext{
		Version:             1,
		Type:                messageTypeMintRequest,
		ChannelID:           h.channel.channelID,
		RequestMessageID:    messageID,
		Origin:              "https://nft.example",
		BrowserPublicKeyJWK: h.browserJWK,
	}
}

func (h *channelHarness) mintRequest(t *testing.T) MintRequest {
	t.Helper()
	return MintRequest{
		ChannelID:           h.channel.channelID,
		MessageID:           "msg_browser",
		Seq:                 7,
		Origin:              "https://nft.example",
		BrowserPublicKeyJWK: h.browserJWK,
	}
}

func (h *channelHarness) decryptMinterMessage(t *testing.T, message encryptedMessage) []byte {
	t.Helper()
	plaintext, aad, err := decryptMessage(h.browserKey, message, h.channel.publicKeyJWK)
	if err != nil {
		t.Fatal(err)
	}
	if aad.ChannelID != h.channel.channelID || aad.Sender != "minter" || aad.Recipient != "browser" {
		t.Fatalf("unexpected AAD: %#v", aad)
	}
	return plaintext
}

func writeJSON(t *testing.T, w http.ResponseWriter, body any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(body); err != nil {
		t.Fatal(err)
	}
}

func readRequestBody(t *testing.T, r *http.Request) string {
	t.Helper()
	body, err := io.ReadAll(r.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

const joinTestOrigin = "https://www.artblocks.io"

// joinHarness is an httptest broker stub for a browser-created channel that the
// minter joins.
type joinHarness struct {
	t            *testing.T
	server       *httptest.Server
	browserKey   *ecdh.PrivateKey
	browserJWK   PublicJWK
	origin       string
	resolveCalls int
	joinBodies   []string
	messages     []encryptedMessage
	sentMessages []encryptedMessage
	closed       bool
	// joinStatus, when set, makes the join endpoint fail with that status.
	joinStatus  int
	joinCode    string
	creatorRole string
}

func newJoinHarness(t *testing.T) *joinHarness {
	t.Helper()
	browserKey, err := generatePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	browserJWK, err := publicKeyToJWK(browserKey.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	h := &joinHarness{t: t, browserKey: browserKey, browserJWK: browserJWK, origin: joinTestOrigin, creatorRole: "browser"}
	h.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/pairing-codes/resolve":
			h.resolveCalls++
			var body resolvePairingCodeRequest
			if err := json.Unmarshal([]byte(readRequestBody(t, r)), &body); err != nil {
				t.Fatal(err)
			}
			if body.ShortCode != "123456" {
				w.WriteHeader(http.StatusNotFound)
				writeJSON(t, w, map[string]string{"error": "not_found"})
				return
			}
			writeJSON(t, w, map[string]any{
				"channelId":           "ch_site",
				"creatorRole":         h.creatorRole,
				"algorithm":           Algorithm,
				"browserPublicKeyJwk": h.browserJWK,
				"origin":              h.origin,
				"expiresAt":           time.Now().Add(5 * time.Minute).UTC(),
			})
		case r.Method == http.MethodPost && r.URL.Path == "/v1/channels/ch_site/join":
			body := readRequestBody(t, r)
			h.joinBodies = append(h.joinBodies, body)
			if h.joinStatus != 0 {
				w.WriteHeader(h.joinStatus)
				writeJSON(t, w, map[string]string{"error": h.joinCode})
				return
			}
			writeJSON(t, w, map[string]any{
				"channelId":           "ch_site",
				"role":                "minter",
				"minterToken":         "mt_joined",
				"algorithm":           Algorithm,
				"browserPublicKeyJwk": h.browserJWK,
				"origin":              h.origin,
				"browserInfo":         map[string]string{"name": "Art Blocks", "label": "artblocks.io", "userAgent": "test", "extra": "ignored"},
				"expiresAt":           time.Now().Add(5 * time.Minute).UTC(),
				"nextSeq":             1,
			})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/channels/ch_site/messages":
			if r.Header.Get("Authorization") != "Bearer mt_joined" {
				t.Fatalf("poll authorization = %q", r.Header.Get("Authorization"))
			}
			writeJSON(t, w, pollMessagesResponse{ChannelID: "ch_site", ExpiresAt: time.Now().Add(5 * time.Minute).UTC(), Messages: h.messages})
		case r.Method == http.MethodPost && r.URL.Path == "/v1/channels/ch_site/messages":
			if r.Header.Get("Authorization") != "Bearer mt_joined" {
				t.Fatalf("send authorization = %q", r.Header.Get("Authorization"))
			}
			var message encryptedMessage
			if err := json.Unmarshal([]byte(readRequestBody(t, r)), &message); err != nil {
				t.Fatal(err)
			}
			h.sentMessages = append(h.sentMessages, message)
			writeJSON(t, w, sendMessageResponse{ChannelID: "ch_site", Seq: 2, ExpiresAt: time.Now().Add(5 * time.Minute).UTC()})
		case r.Method == http.MethodDelete && r.URL.Path == "/v1/channels/ch_site":
			if r.Header.Get("Authorization") != "Bearer mt_joined" {
				t.Fatalf("close authorization = %q", r.Header.Get("Authorization"))
			}
			h.closed = true
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
	}))
	t.Cleanup(h.server.Close)
	return h
}

func (h *joinHarness) join(t *testing.T, opts JoinChannelOptions) *Channel {
	t.Helper()
	opts.BrokerBaseURL = h.server.URL
	channel, err := NewClient(h.server.Client()).JoinChannel(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	return channel
}

// mintRequest encrypts a browser mint_request to the joined minter with the
// given browser key and origin.
func (h *joinHarness) mintRequest(t *testing.T, channel *Channel, browserKey *ecdh.PrivateKey, origin string) encryptedMessage {
	t.Helper()
	browserJWK, err := publicKeyToJWK(browserKey.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	aad := envelopeAAD{Version: 1, ChannelID: "ch_site", MessageID: "msg_browser", Seq: 1, Sender: "browser", Recipient: "minter", Algorithm: Algorithm}
	message, err := encryptJSON(browserKey, channel.MinterPublicKeyJWK(), aad, mintRequestPlaintext{
		Version:                    1,
		Type:                       messageTypeMintRequest,
		ChannelID:                  "ch_site",
		RequestMessageID:           "msg_browser",
		Origin:                     origin,
		BrowserInfo:                BrowserInfo{Name: "Art Blocks"},
		BrowserPublicKeyJWK:        browserJWK,
		SupportsPersistentSessions: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	message.Seq = 1
	message.SenderPublicKeyJWK = &browserJWK
	return message
}

func TestJoinChannelWithPairingToken(t *testing.T) {
	h := newJoinHarness(t)
	channel := h.join(t, JoinChannelOptions{ChannelID: "ch_site", PairingToken: "pt_secret"})

	if h.resolveCalls != 0 {
		t.Fatalf("pairing-token join resolved a code %d times", h.resolveCalls)
	}
	if len(h.joinBodies) != 1 {
		t.Fatalf("join calls = %d, want 1", len(h.joinBodies))
	}
	var joinBody map[string]json.RawMessage
	if err := json.Unmarshal([]byte(h.joinBodies[0]), &joinBody); err != nil {
		t.Fatal(err)
	}
	if string(joinBody["pairingToken"]) != `"pt_secret"` || joinBody["minterPublicKeyJwk"] == nil {
		t.Fatalf("join body = %s", h.joinBodies[0])
	}
	for _, field := range []string{"shortCode", "browserPublicKeyJwk", "origin", "browserInfo"} {
		if _, ok := joinBody[field]; ok {
			t.Fatalf("join body carries %s: %s", field, h.joinBodies[0])
		}
	}

	requester := channel.Requester()
	if requester.Origin != joinTestOrigin || requester.BrowserInfo.Name != "Art Blocks" || requester.BrowserInfo.Label != "artblocks.io" {
		t.Fatalf("requester = %#v", requester)
	}
	if channel.ChannelID() != "ch_site" {
		t.Fatalf("channel id = %q", channel.ChannelID())
	}
	if display := channel.PairingDisplay(); display.ChannelID != "" || display.ShortCode != "" || display.QRPayload != nil || !display.ExpiresAt.IsZero() {
		t.Fatalf("joined channel display = %#v, want zero value", display)
	}

	h.messages = []encryptedMessage{h.mintRequest(t, channel, h.browserKey, joinTestOrigin)}
	request, err := channel.PollMintRequest(context.Background(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if request == nil || request.Origin != joinTestOrigin || request.ChannelID != "ch_site" || !request.SupportsPersistentSessions {
		t.Fatalf("mint request = %#v", request)
	}

	if _, err := channel.SendMintSuccess(context.Background(), *request, MintResult{SessionID: "ses_1", Token: "eph_token", Persistent: true}); err != nil {
		t.Fatal(err)
	}
	if len(h.sentMessages) != 1 {
		t.Fatalf("sent messages = %d, want 1", len(h.sentMessages))
	}
	plaintext, aad, err := decryptMessage(h.browserKey, h.sentMessages[0], channel.MinterPublicKeyJWK())
	if err != nil {
		t.Fatal(err)
	}
	if aad.Sender != "minter" || aad.Recipient != "browser" || !strings.Contains(string(plaintext), `"eph_token"`) {
		t.Fatalf("success payload aad=%#v plaintext=%s", aad, plaintext)
	}
	if err := channel.Close(context.Background()); err != nil || !h.closed {
		t.Fatalf("close err=%v closed=%t", err, h.closed)
	}
}

func TestJoinChannelWithShortCode(t *testing.T) {
	h := newJoinHarness(t)
	channel := h.join(t, JoinChannelOptions{ShortCode: "123456"})
	if h.resolveCalls != 1 || len(h.joinBodies) != 1 {
		t.Fatalf("resolve/join calls = %d/%d, want 1/1", h.resolveCalls, len(h.joinBodies))
	}
	var joinBody map[string]json.RawMessage
	if err := json.Unmarshal([]byte(h.joinBodies[0]), &joinBody); err != nil {
		t.Fatal(err)
	}
	if string(joinBody["shortCode"]) != `"123456"` || joinBody["pairingToken"] != nil {
		t.Fatalf("join body = %s", h.joinBodies[0])
	}
	if channel.ChannelID() != "ch_site" || channel.Requester().Origin != joinTestOrigin {
		t.Fatalf("joined channel id/origin = %q/%q", channel.ChannelID(), channel.Requester().Origin)
	}
}

func TestJoinChannelRejectsMinterCreatedShortCode(t *testing.T) {
	h := newJoinHarness(t)
	h.creatorRole = "minter"
	_, err := NewClient(h.server.Client()).JoinChannel(context.Background(), JoinChannelOptions{BrokerBaseURL: h.server.URL, ShortCode: "123456"})
	if err == nil || len(h.joinBodies) != 0 {
		t.Fatalf("join of a minter-created code err=%v joins=%d, want error before join", err, len(h.joinBodies))
	}
}

func TestPollMintRequestRejectsOriginMismatchOnJoinedChannel(t *testing.T) {
	h := newJoinHarness(t)
	channel := h.join(t, JoinChannelOptions{ChannelID: "ch_site", PairingToken: "pt_secret"})
	h.messages = []encryptedMessage{h.mintRequest(t, channel, h.browserKey, "https://evil.example")}
	request, err := channel.PollMintRequest(context.Background(), 0)
	if !errors.Is(err, ErrOriginMismatch) {
		t.Fatalf("PollMintRequest error = %v; want ErrOriginMismatch", err)
	}
	if request == nil || request.ChannelID != "ch_site" || request.MessageID != "msg_browser" || request.Seq != 1 || request.Origin != "https://evil.example" || request.BrowserInfo.Name != "Art Blocks" || !publicJWKMatches(request.BrowserPublicKeyJWK, h.browserJWK) {
		t.Fatalf("refused request = %#v, want the decrypted request", request)
	}
	// The host answers the refused request with an encrypted rejection.
	if _, err := channel.SendMintRejection(context.Background(), *request, MintRejection{Reason: "origin_mismatch"}); err != nil {
		t.Fatal(err)
	}
	plaintext, _, err := decryptMessage(h.browserKey, h.sentMessages[0], channel.MinterPublicKeyJWK())
	if err != nil || !strings.Contains(string(plaintext), `"mint_rejected"`) || !strings.Contains(string(plaintext), `"requestMessageId":"msg_browser"`) {
		t.Fatalf("rejection plaintext = %s, %v", plaintext, err)
	}
}

func TestPollMintRequestRejectsBrowserKeyMismatchOnJoinedChannel(t *testing.T) {
	h := newJoinHarness(t)
	channel := h.join(t, JoinChannelOptions{ChannelID: "ch_site", PairingToken: "pt_secret"})
	otherKey, err := generatePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	// Envelope and plaintext agree on the other key, so only the comparison
	// against the key the broker returned at join catches it.
	h.messages = []encryptedMessage{h.mintRequest(t, channel, otherKey, joinTestOrigin)}
	request, err := channel.PollMintRequest(context.Background(), 0)
	if !errors.Is(err, ErrBrowserKeyMismatch) {
		t.Fatalf("PollMintRequest error = %v; want ErrBrowserKeyMismatch", err)
	}
	otherJWK, err := publicKeyToJWK(otherKey.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	if request == nil || request.ChannelID != "ch_site" || request.MessageID != "msg_browser" || request.Seq != 1 || request.Origin != joinTestOrigin || !publicJWKMatches(request.BrowserPublicKeyJWK, otherJWK) {
		t.Fatalf("refused request = %#v, want the decrypted request", request)
	}
}

func TestPollMintRequestOtherErrorsReturnNoRequest(t *testing.T) {
	h := newJoinHarness(t)
	channel := h.join(t, JoinChannelOptions{ChannelID: "ch_site", PairingToken: "pt_secret"})
	message := h.mintRequest(t, channel, h.browserKey, joinTestOrigin)
	message.Ciphertext = message.Ciphertext[:len(message.Ciphertext)-4] + "AAAA"
	h.messages = []encryptedMessage{message}
	request, err := channel.PollMintRequest(context.Background(), 0)
	if err == nil || errors.Is(err, ErrOriginMismatch) || errors.Is(err, ErrBrowserKeyMismatch) || request != nil {
		t.Fatalf("tampered request = %#v, %v; want a nil request with a non-sentinel error", request, err)
	}
}

func TestCreatedChannelHasNoRequester(t *testing.T) {
	h := newChannelHarness(t)
	if requester := h.channel.Requester(); requester != (JoinedRequester{}) {
		t.Fatalf("created channel requester = %#v, want zero value", requester)
	}
	// A created channel keeps accepting whatever origin the request names.
	plaintext := h.validMintRequestPlaintext("msg_browser")
	plaintext.Origin = "https://other.example"
	h.messages = []encryptedMessage{h.encryptBrowserMessage(t, "msg_browser", 1, plaintext)}
	request, err := h.channel.PollMintRequest(context.Background(), 0)
	if err != nil || request == nil || request.Origin != "https://other.example" {
		t.Fatalf("created channel poll = %#v, %v", request, err)
	}
}

func TestJoinChannelBrokerErrorsCarryStatus(t *testing.T) {
	for _, tc := range []struct {
		status int
		code   string
	}{
		{http.StatusNotFound, "not_found"},
		{http.StatusGone, "expired"},
		{http.StatusUnauthorized, "unauthorized"},
		{http.StatusTooManyRequests, "rate_limited"},
	} {
		t.Run(tc.code, func(t *testing.T) {
			h := newJoinHarness(t)
			h.joinStatus, h.joinCode = tc.status, tc.code
			_, err := NewClient(h.server.Client()).JoinChannel(context.Background(), JoinChannelOptions{BrokerBaseURL: h.server.URL, ChannelID: "ch_site", PairingToken: "pt_secret"})
			var brokerErr *BrokerError
			if !errors.As(err, &brokerErr) || brokerErr.StatusCode != tc.status || brokerErr.Code != tc.code {
				t.Fatalf("err = %v (%#v), want BrokerError %d/%s", err, brokerErr, tc.status, tc.code)
			}
		})
	}

	h := newJoinHarness(t)
	_, err := NewClient(h.server.Client()).JoinChannel(context.Background(), JoinChannelOptions{BrokerBaseURL: h.server.URL, ShortCode: "000000"})
	var brokerErr *BrokerError
	if !errors.As(err, &brokerErr) || brokerErr.StatusCode != http.StatusNotFound || len(h.joinBodies) != 0 {
		t.Fatalf("unknown short code err = %v, want 404 BrokerError before join", err)
	}
}

func TestJoinChannelValidatesOptions(t *testing.T) {
	client := NewClient(nil)
	for name, opts := range map[string]JoinChannelOptions{
		"broker url required":        {ChannelID: "ch_site", PairingToken: "pt_secret"},
		"credential required":        {BrokerBaseURL: "https://broker.test", ChannelID: "ch_site"},
		"both credentials":           {BrokerBaseURL: "https://broker.test", ChannelID: "ch_site", PairingToken: "pt_secret", ShortCode: "123456"},
		"channel id with token":      {BrokerBaseURL: "https://broker.test", PairingToken: "pt_secret"},
		"channel id with short code": {BrokerBaseURL: "https://broker.test", ChannelID: "ch_site", ShortCode: "123456"},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := client.JoinChannel(context.Background(), opts); err == nil {
				t.Fatal("expected option validation error")
			}
		})
	}
}
