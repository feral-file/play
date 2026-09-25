package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	bolt "go.etcd.io/bbolt"
)

var testPublicJWK = json.RawMessage(`{"kty":"EC","crv":"P-256","x":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","y":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}`)
var alternatePublicJWK = json.RawMessage(`{"kty":"EC","crv":"P-256","x":"ccccccccccccccccccccccccccccccccccccccccccc","y":"ddddddddddddddddddddddddddddddddddddddddddd"}`)

type testEnv struct {
	broker *Broker
	server *httptest.Server
	clock  *time.Time
	dbPath string
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	start := time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC)
	env := &testEnv{
		clock:  &start,
		dbPath: filepath.Join(t.TempDir(), "broker.db"),
	}
	broker, err := NewBroker(Config{
		DBPath:        env.dbPath,
		BrokerBaseURL: "https://pairing.test",
		Now: func() time.Time {
			return *env.clock
		},
	})
	if err != nil {
		t.Fatalf("NewBroker: %v", err)
	}
	env.broker = broker
	env.server = httptest.NewServer(broker)
	t.Cleanup(func() {
		env.server.Close()
		if err := env.broker.Close(); err != nil {
			t.Fatalf("close broker: %v", err)
		}
	})
	return env
}

func (env *testEnv) restart(t *testing.T) {
	t.Helper()
	env.server.Close()
	if err := env.broker.Close(); err != nil {
		t.Fatalf("close broker before restart: %v", err)
	}
	broker, err := NewBroker(Config{
		DBPath:        env.dbPath,
		BrokerBaseURL: "https://pairing.test",
		Now: func() time.Time {
			return *env.clock
		},
	})
	if err != nil {
		t.Fatalf("restart broker: %v", err)
	}
	env.broker = broker
	env.server = httptest.NewServer(broker)
}

func TestCreateAndJoinChannel(t *testing.T) {
	env := newTestEnv(t)
	created := createChannel(t, env, true)
	if created.ChannelID == "" || created.MinterToken == "" || created.PairingToken == "" || created.ShortCode == "" {
		t.Fatalf("create response omitted pairing material: %+v", created)
	}

	joined := joinWithPairingToken(t, env, created)
	if joined.ChannelID != created.ChannelID {
		t.Fatalf("joined channel = %q, want %q", joined.ChannelID, created.ChannelID)
	}
	if joined.BrowserToken == "" {
		t.Fatal("join response omitted browser token")
	}
	if joined.NextSeq != 1 {
		t.Fatalf("nextSeq = %d, want 1", joined.NextSeq)
	}
	if !bytes.Equal(joined.MinterPublicKeyJWK, testPublicJWK) {
		t.Fatalf("minter public key mismatch: %s", joined.MinterPublicKeyJWK)
	}
}

func TestDuplicateJoinRejected(t *testing.T) {
	env := newTestEnv(t)
	created := createChannel(t, env, false)
	_ = joinWithPairingToken(t, env, created)

	status, errCode := postJSON(t, env.server.URL+"/v1/channels/"+created.ChannelID+"/join", "", JoinChannelRequest{
		PairingToken:        created.PairingToken,
		BrowserPublicKeyJWK: testPublicJWK,
		Origin:              "https://nft.example",
	}, nil)
	if status != http.StatusUnauthorized || errCode != "unauthorized" {
		t.Fatalf("duplicate join status/error = %d/%q, want 401/unauthorized", status, errCode)
	}
}

func TestMessageAuth(t *testing.T) {
	env := newTestEnv(t)
	created := createChannel(t, env, false)
	joined := joinWithPairingToken(t, env, created)

	req := AppendMessageRequest{
		MessageID:  "msg_auth",
		Sender:     roleBrowser,
		Recipient:  roleMinter,
		Algorithm:  algorithm,
		AAD:        "aad",
		Nonce:      "nonce",
		Ciphertext: "ciphertext",
	}
	status, errCode := postJSON(t, env.server.URL+"/v1/channels/"+created.ChannelID+"/messages", "wrong-token", req, nil)
	if status != http.StatusUnauthorized || errCode != "unauthorized" {
		t.Fatalf("bad bearer status/error = %d/%q, want 401/unauthorized", status, errCode)
	}

	req.Sender = roleMinter
	req.Recipient = roleBrowser
	status, errCode = postJSON(t, env.server.URL+"/v1/channels/"+created.ChannelID+"/messages", joined.BrowserToken, req, nil)
	if status != http.StatusUnauthorized || errCode != "unauthorized" {
		t.Fatalf("sender mismatch status/error = %d/%q, want 401/unauthorized", status, errCode)
	}
}

func TestBrowserAppendSenderPublicKeyMustMatchJoinKey(t *testing.T) {
	env := newTestEnv(t)
	created := createChannel(t, env, false)
	joined := joinWithPairingToken(t, env, created)

	endpoint := env.server.URL + "/v1/channels/" + created.ChannelID + "/messages"
	status, errCode := postJSON(t, endpoint, joined.BrowserToken, AppendMessageRequest{
		MessageID:          "msg_wrong_browser_key",
		Sender:             roleBrowser,
		Recipient:          roleMinter,
		Algorithm:          algorithm,
		AAD:                "aad",
		Nonce:              "nonce",
		Ciphertext:         "ciphertext",
		SenderPublicKeyJWK: alternatePublicJWK,
	}, nil)
	if status != http.StatusBadRequest || errCode != "invalid_request" {
		t.Fatalf("mismatched browser sender key status/error = %d/%q, want 400/invalid_request", status, errCode)
	}

	appendResponse := appendMessage(t, env, created.ChannelID, joined.BrowserToken, AppendMessageRequest{
		MessageID:          "msg_joined_browser_key",
		Sender:             roleBrowser,
		Recipient:          roleMinter,
		Algorithm:          algorithm,
		AAD:                "aad",
		Nonce:              "nonce",
		Ciphertext:         "ciphertext",
		SenderPublicKeyJWK: testPublicJWK,
	})
	if appendResponse.Seq != 1 {
		t.Fatalf("accepted browser append seq = %d, want 1", appendResponse.Seq)
	}
}

func TestAppendAndPollBothDirections(t *testing.T) {
	env := newTestEnv(t)
	created := createChannel(t, env, false)
	joined := joinWithPairingToken(t, env, created)

	browserAppend := appendMessage(t, env, created.ChannelID, joined.BrowserToken, AppendMessageRequest{
		MessageID:          "msg_browser",
		Sender:             roleBrowser,
		Recipient:          roleMinter,
		Algorithm:          algorithm,
		AAD:                "aad-browser",
		Nonce:              "nonce-browser",
		Ciphertext:         "ciphertext-browser",
		SenderPublicKeyJWK: testPublicJWK,
	})
	if browserAppend.Seq != 1 {
		t.Fatalf("browser append seq = %d, want 1", browserAppend.Seq)
	}

	minterPoll := pollMessages(t, env, created.ChannelID, created.MinterToken, 0)
	if len(minterPoll.Messages) != 1 || minterPoll.Messages[0].MessageID != "msg_browser" {
		t.Fatalf("minter poll messages = %+v", minterPoll.Messages)
	}

	minterAppend := appendMessage(t, env, created.ChannelID, created.MinterToken, AppendMessageRequest{
		MessageID:  "msg_minter",
		Sender:     roleMinter,
		Recipient:  roleBrowser,
		Algorithm:  algorithm,
		AAD:        "aad-minter",
		Nonce:      "nonce-minter",
		Ciphertext: "ciphertext-minter",
	})
	if minterAppend.Seq != 2 {
		t.Fatalf("minter append seq = %d, want 2", minterAppend.Seq)
	}

	browserPoll := pollMessages(t, env, created.ChannelID, joined.BrowserToken, 0)
	if len(browserPoll.Messages) != 1 || browserPoll.Messages[0].MessageID != "msg_minter" {
		t.Fatalf("browser poll messages = %+v", browserPoll.Messages)
	}
}

func TestDuplicateMessageRejected(t *testing.T) {
	env := newTestEnv(t)
	created := createChannel(t, env, false)
	joined := joinWithPairingToken(t, env, created)

	req := AppendMessageRequest{
		MessageID:          "msg_duplicate",
		Sender:             roleBrowser,
		Recipient:          roleMinter,
		Algorithm:          algorithm,
		AAD:                "aad",
		Nonce:              "nonce",
		Ciphertext:         "ciphertext",
		SenderPublicKeyJWK: testPublicJWK,
	}
	first := appendMessage(t, env, created.ChannelID, joined.BrowserToken, req)
	if first.Seq != 1 {
		t.Fatalf("first append seq = %d, want 1", first.Seq)
	}

	status, errCode := postJSON(t, env.server.URL+"/v1/channels/"+created.ChannelID+"/messages", joined.BrowserToken, req, nil)
	if status != http.StatusConflict || errCode != "duplicate_message" {
		t.Fatalf("duplicate append status/error = %d/%q, want 409/duplicate_message", status, errCode)
	}

	minterAppend := appendMessage(t, env, created.ChannelID, created.MinterToken, AppendMessageRequest{
		MessageID:  "msg_duplicate",
		Sender:     roleMinter,
		Recipient:  roleBrowser,
		Algorithm:  algorithm,
		AAD:        "aad-minter",
		Nonce:      "nonce-minter",
		Ciphertext: "ciphertext-minter",
	})
	if minterAppend.Seq != 2 {
		t.Fatalf("opposite sender duplicate messageId seq = %d, want 2", minterAppend.Seq)
	}
}

func TestTTLOnlyExtendsOnAcceptedMessages(t *testing.T) {
	env := newTestEnv(t)
	created := createChannel(t, env, false)
	initialExpiresAt := created.ExpiresAt

	*env.clock = env.clock.Add(5 * time.Second)
	joined := joinWithPairingToken(t, env, created)
	if joined.ExpiresAt != initialExpiresAt {
		t.Fatalf("join extended TTL: got %s, want %s", joined.ExpiresAt, initialExpiresAt)
	}

	*env.clock = env.clock.Add(2 * time.Second)
	appendResponse := appendMessage(t, env, created.ChannelID, joined.BrowserToken, AppendMessageRequest{
		MessageID:          "msg_ttl",
		Sender:             roleBrowser,
		Recipient:          roleMinter,
		Algorithm:          algorithm,
		AAD:                "aad",
		Nonce:              "nonce",
		Ciphertext:         "ciphertext",
		SenderPublicKeyJWK: testPublicJWK,
	})
	expectedAfterAppend := formatTime(env.clock.Add(15 * time.Second))
	if appendResponse.ExpiresAt != expectedAfterAppend {
		t.Fatalf("append expiresAt = %s, want %s", appendResponse.ExpiresAt, expectedAfterAppend)
	}

	*env.clock = env.clock.Add(3 * time.Second)
	pollResponse := pollMessages(t, env, created.ChannelID, created.MinterToken, 0)
	if pollResponse.ExpiresAt != appendResponse.ExpiresAt {
		t.Fatalf("poll extended TTL: got %s, want %s", pollResponse.ExpiresAt, appendResponse.ExpiresAt)
	}
}

func TestMalformedPollAfterSeqRejected(t *testing.T) {
	env := newTestEnv(t)
	created := createChannel(t, env, false)
	tests := []struct {
		name     string
		afterSeq string
	}{
		{
			name:     "non numeric",
			afterSeq: "not-a-number",
		},
		{
			name:     "negative",
			afterSeq: "-1",
		},
		{
			name:     "uint64 overflow",
			afterSeq: "18446744073709551616",
		},
		{
			name:     "max uint64 boundary",
			afterSeq: strconv.FormatUint(math.MaxUint64, 10),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			status, errCode := getJSON(t, env.server.URL+"/v1/channels/"+created.ChannelID+"/messages?afterSeq="+tt.afterSeq, created.MinterToken, nil)
			if status != http.StatusBadRequest || errCode != "invalid_request" {
				t.Fatalf("status/error = %d/%q, want 400/invalid_request", status, errCode)
			}
		})
	}
}

func TestPollExpiryPersistsAfterRestart(t *testing.T) {
	env := newTestEnv(t)
	created := createChannel(t, env, false)
	joined := joinWithPairingToken(t, env, created)
	*env.clock = env.clock.Add(16 * time.Second)

	status, errCode := getJSON(t, env.server.URL+"/v1/channels/"+created.ChannelID+"/messages?afterSeq=0", created.MinterToken, nil)
	if status != http.StatusGone || errCode != "expired" {
		t.Fatalf("expired poll status/error = %d/%q, want 410/expired", status, errCode)
	}
	if got := channelStatus(t, env, created.ChannelID); got != statusExpired {
		t.Fatalf("channel status after expired poll = %q, want %q", got, statusExpired)
	}

	env.restart(t)
	if got := channelStatus(t, env, created.ChannelID); got != statusExpired {
		t.Fatalf("channel status after restart = %q, want %q", got, statusExpired)
	}
	status, errCode = postJSON(t, env.server.URL+"/v1/channels/"+created.ChannelID+"/messages", joined.BrowserToken, AppendMessageRequest{
		MessageID:  "msg_after_expiry",
		Sender:     roleBrowser,
		Recipient:  roleMinter,
		Algorithm:  algorithm,
		AAD:        "aad",
		Nonce:      "nonce",
		Ciphertext: "ciphertext",
	}, nil)
	if status != http.StatusGone || errCode != "expired" {
		t.Fatalf("append after persisted expiry status/error = %d/%q, want 410/expired", status, errCode)
	}
}

func TestExpiredChannelRejectsMessages(t *testing.T) {
	env := newTestEnv(t)
	created := createChannel(t, env, false)
	joined := joinWithPairingToken(t, env, created)
	*env.clock = env.clock.Add(16 * time.Second)

	status, errCode := postJSON(t, env.server.URL+"/v1/channels/"+created.ChannelID+"/messages", joined.BrowserToken, AppendMessageRequest{
		MessageID:  "msg_expired",
		Sender:     roleBrowser,
		Recipient:  roleMinter,
		Algorithm:  algorithm,
		AAD:        "aad",
		Nonce:      "nonce",
		Ciphertext: "ciphertext",
	}, nil)
	if status != http.StatusGone || errCode != "expired" {
		t.Fatalf("expired append status/error = %d/%q, want 410/expired", status, errCode)
	}
}

func TestOversizedPayloadRejected(t *testing.T) {
	env := newTestEnv(t)
	created := createChannel(t, env, false)
	joined := joinWithPairingToken(t, env, created)

	status, errCode := postJSON(t, env.server.URL+"/v1/channels/"+created.ChannelID+"/messages", joined.BrowserToken, AppendMessageRequest{
		MessageID:  "msg_large",
		Sender:     roleBrowser,
		Recipient:  roleMinter,
		Algorithm:  algorithm,
		AAD:        "aad",
		Nonce:      "nonce",
		Ciphertext: strings.Repeat("x", maxEncryptedPayloadBytes+1),
	}, nil)
	if status != http.StatusRequestEntityTooLarge || errCode != "payload_too_large" {
		t.Fatalf("oversized append status/error = %d/%q, want 413/payload_too_large", status, errCode)
	}
}

func TestMalformedCreateRequestsRejected(t *testing.T) {
	env := newTestEnv(t)
	validPublicKey := string(testPublicJWK)
	tests := []struct {
		name string
		body string
	}{
		{
			name: "unknown field",
			body: `{"algorithm":"` + algorithm + `","minterPublicKeyJwk":` + validPublicKey + `,"idleTtlSeconds":15,"unexpected":true}`,
		},
		{
			name: "bad json",
			body: `{"algorithm":`,
		},
		{
			name: "trailing json",
			body: `{"algorithm":"` + algorithm + `","minterPublicKeyJwk":` + validPublicKey + `,"idleTtlSeconds":15}{}`,
		},
		{
			name: "ttl below minimum",
			body: `{"algorithm":"` + algorithm + `","minterPublicKeyJwk":` + validPublicKey + `,"idleTtlSeconds":14}`,
		},
		{
			name: "ttl above maximum",
			body: `{"algorithm":"` + algorithm + `","minterPublicKeyJwk":` + validPublicKey + `,"idleTtlSeconds":301}`,
		},
		{
			name: "public key must be object",
			body: `{"algorithm":"` + algorithm + `","minterPublicKeyJwk":[],"idleTtlSeconds":15}`,
		},
		{
			name: "public key object must contain valid json",
			body: `{"algorithm":"` + algorithm + `","minterPublicKeyJwk":{"kty":},"idleTtlSeconds":15}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			status, errCode := postRawJSON(t, env.server.URL+"/v1/channels", "", tt.body, nil)
			if status != http.StatusBadRequest || errCode != "invalid_request" {
				t.Fatalf("status/error = %d/%q, want 400/invalid_request", status, errCode)
			}
		})
	}
}

func TestMalformedJoinRequestsRejected(t *testing.T) {
	env := newTestEnv(t)
	created := createChannel(t, env, true)
	validPublicKey := string(testPublicJWK)
	tests := []struct {
		name string
		body string
	}{
		{
			name: "unknown field",
			body: `{"pairingToken":"` + created.PairingToken + `","browserPublicKeyJwk":` + validPublicKey + `,"origin":"https://nft.example","unexpected":true}`,
		},
		{
			name: "browser public key must be object",
			body: `{"pairingToken":"` + created.PairingToken + `","browserPublicKeyJwk":[],"origin":"https://nft.example"}`,
		},
		{
			name: "browser info must be object",
			body: `{"pairingToken":"` + created.PairingToken + `","browserPublicKeyJwk":` + validPublicKey + `,"origin":"https://nft.example","browserInfo":[]}`,
		},
		{
			name: "pairing token and short code are mutually exclusive",
			body: `{"pairingToken":"` + created.PairingToken + `","shortCode":"` + created.ShortCode + `","browserPublicKeyJwk":` + validPublicKey + `,"origin":"https://nft.example"}`,
		},
		{
			name: "credential required",
			body: `{"browserPublicKeyJwk":` + validPublicKey + `,"origin":"https://nft.example"}`,
		},
		{
			name: "bad pairing token shape",
			body: `{"pairingToken":"not-a-pairing-token","browserPublicKeyJwk":` + validPublicKey + `,"origin":"https://nft.example"}`,
		},
		{
			name: "bad short code shape",
			body: `{"shortCode":"12AB56","browserPublicKeyJwk":` + validPublicKey + `,"origin":"https://nft.example"}`,
		},
		{
			name: "origin must be absolute",
			body: `{"pairingToken":"` + created.PairingToken + `","browserPublicKeyJwk":` + validPublicKey + `,"origin":"nft.example"}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			status, errCode := postRawJSON(t, env.server.URL+"/v1/channels/"+created.ChannelID+"/join", "", tt.body, nil)
			if status != http.StatusBadRequest || errCode != "invalid_request" {
				t.Fatalf("status/error = %d/%q, want 400/invalid_request", status, errCode)
			}
		})
	}
}

func TestMalformedAppendMessageRequestsRejected(t *testing.T) {
	env := newTestEnv(t)
	created := createChannel(t, env, false)
	joined := joinWithPairingToken(t, env, created)
	endpoint := env.server.URL + "/v1/channels/" + created.ChannelID + "/messages"
	tests := []struct {
		name string
		body string
	}{
		{
			name: "unknown field",
			body: `{"messageId":"msg_unknown","sender":"browser","recipient":"minter","algorithm":"` + algorithm + `","aad":"aad","nonce":"nonce","ciphertext":"ciphertext","unexpected":true}`,
		},
		{
			name: "invalid sender role",
			body: `{"messageId":"msg_sender","sender":"controller","recipient":"minter","algorithm":"` + algorithm + `","aad":"aad","nonce":"nonce","ciphertext":"ciphertext"}`,
		},
		{
			name: "invalid recipient role",
			body: `{"messageId":"msg_recipient","sender":"browser","recipient":"controller","algorithm":"` + algorithm + `","aad":"aad","nonce":"nonce","ciphertext":"ciphertext"}`,
		},
		{
			name: "sender and recipient must differ",
			body: `{"messageId":"msg_same_role","sender":"browser","recipient":"browser","algorithm":"` + algorithm + `","aad":"aad","nonce":"nonce","ciphertext":"ciphertext"}`,
		},
		{
			name: "message id required",
			body: `{"sender":"browser","recipient":"minter","algorithm":"` + algorithm + `","aad":"aad","nonce":"nonce","ciphertext":"ciphertext"}`,
		},
		{
			name: "nonce required",
			body: `{"messageId":"msg_nonce","sender":"browser","recipient":"minter","algorithm":"` + algorithm + `","aad":"aad","ciphertext":"ciphertext"}`,
		},
		{
			name: "ciphertext required",
			body: `{"messageId":"msg_ciphertext","sender":"browser","recipient":"minter","algorithm":"` + algorithm + `","aad":"aad","nonce":"nonce"}`,
		},
		{
			name: "sender public key must be object",
			body: `{"messageId":"msg_sender_key","sender":"browser","recipient":"minter","algorithm":"` + algorithm + `","aad":"aad","nonce":"nonce","ciphertext":"ciphertext","senderPublicKeyJwk":[]}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			status, errCode := postRawJSON(t, endpoint, joined.BrowserToken, tt.body, nil)
			if status != http.StatusBadRequest || errCode != "invalid_request" {
				t.Fatalf("status/error = %d/%q, want 400/invalid_request", status, errCode)
			}
		})
	}
}

func TestShortCodeResolveSourceRateLimitPersistsAcrossRestart(t *testing.T) {
	env := newTestEnv(t)
	created := createChannel(t, env, true)
	for misses, candidate := 0, 0; misses < shortCodeAttemptLimit; candidate++ {
		code := fmt.Sprintf("%06d", candidate)
		if code == created.ShortCode {
			continue
		}
		status, errCode := postJSONFromRemote(t, env.broker, "198.51.100.10:12345", "/v1/pairing-codes/resolve", "", ResolvePairingCodeRequest{
			ShortCode: code,
		}, nil)
		if status != http.StatusNotFound || errCode != "not_found" {
			t.Fatalf("resolve miss %d status/error = %d/%q, want 404/not_found", misses, status, errCode)
		}
		misses++
	}

	env.restart(t)
	status, errCode := postJSONFromRemote(t, env.broker, "198.51.100.10:54321", "/v1/pairing-codes/resolve", "", ResolvePairingCodeRequest{
		ShortCode: "999999",
	}, nil)
	if status != http.StatusTooManyRequests || errCode != "rate_limited" {
		t.Fatalf("source limited resolve status/error = %d/%q, want 429/rate_limited", status, errCode)
	}

	var resolved ResolvePairingCodeResponse
	status, errCode = postJSONFromRemote(t, env.broker, "198.51.100.11:12345", "/v1/pairing-codes/resolve", "", ResolvePairingCodeRequest{
		ShortCode: created.ShortCode,
	}, &resolved)
	if status != http.StatusOK || errCode != "" {
		t.Fatalf("valid resolve from other source status/error = %d/%q, want 200", status, errCode)
	}
	if resolved.ChannelID != created.ChannelID {
		t.Fatalf("resolved channel = %q, want %q", resolved.ChannelID, created.ChannelID)
	}
}

func TestShortCodeResolve(t *testing.T) {
	env := newTestEnv(t)
	created := createChannel(t, env, true)

	var resolved ResolvePairingCodeResponse
	status, errCode := postJSON(t, env.server.URL+"/v1/pairing-codes/resolve", "", ResolvePairingCodeRequest{
		ShortCode: created.ShortCode,
	}, &resolved)
	if status != http.StatusOK || errCode != "" {
		t.Fatalf("resolve status/error = %d/%q, want 200", status, errCode)
	}
	if resolved.ChannelID != created.ChannelID || resolved.Algorithm != algorithm {
		t.Fatalf("resolved response = %+v, created channel = %s", resolved, created.ChannelID)
	}
	if !bytes.Equal(resolved.MinterPublicKeyJWK, testPublicJWK) {
		t.Fatalf("resolved public key mismatch: %s", resolved.MinterPublicKeyJWK)
	}
}

func TestCleanupRemovesExpiredChannelAfterRestart(t *testing.T) {
	env := newTestEnv(t)
	created := createChannel(t, env, true)
	*env.clock = env.clock.Add(16 * time.Second)
	env.restart(t)

	if err := env.broker.cleanupExpiredChannels(*env.clock, cleanupBatchLimit); err != nil {
		t.Fatalf("cleanup expired channels: %v", err)
	}
	if channelExists(t, env, created.ChannelID) {
		t.Fatalf("expired channel %s still exists after cleanup", created.ChannelID)
	}

	status, errCode := postJSON(t, env.server.URL+"/v1/pairing-codes/resolve", "", ResolvePairingCodeRequest{
		ShortCode: created.ShortCode,
	}, nil)
	if status != http.StatusNotFound || errCode != "not_found" {
		t.Fatalf("resolve cleaned short code status/error = %d/%q, want 404/not_found", status, errCode)
	}
}

func TestCleanupIgnoresStaleExpiryIndexUntilCurrentExpiry(t *testing.T) {
	env := newTestEnv(t)
	created := createChannel(t, env, false)
	joined := joinWithPairingToken(t, env, created)

	*env.clock = env.clock.Add(5 * time.Second)
	appendResponse := appendMessage(t, env, created.ChannelID, joined.BrowserToken, AppendMessageRequest{
		MessageID:          "msg_extend_expiry",
		Sender:             roleBrowser,
		Recipient:          roleMinter,
		Algorithm:          algorithm,
		AAD:                "aad",
		Nonce:              "nonce",
		Ciphertext:         "ciphertext",
		SenderPublicKeyJWK: testPublicJWK,
	})

	*env.clock = env.clock.Add(11 * time.Second)
	if err := env.broker.cleanupExpiredChannels(*env.clock, cleanupBatchLimit); err != nil {
		t.Fatalf("cleanup stale expiry: %v", err)
	}
	if !channelExists(t, env, created.ChannelID) {
		t.Fatalf("channel was removed at stale initial expiry")
	}

	expiresAt, err := time.Parse(time.RFC3339Nano, appendResponse.ExpiresAt)
	if err != nil {
		t.Fatalf("parse append expiresAt: %v", err)
	}
	*env.clock = expiresAt.Add(time.Second)
	if err := env.broker.cleanupExpiredChannels(*env.clock, cleanupBatchLimit); err != nil {
		t.Fatalf("cleanup current expiry: %v", err)
	}
	if channelExists(t, env, created.ChannelID) {
		t.Fatalf("channel still exists after current expiry cleanup")
	}
}

func TestCloseChannel(t *testing.T) {
	env := newTestEnv(t)
	created := createChannel(t, env, true)
	joined := joinWithPairingToken(t, env, created)

	status, errCode := deleteJSON(t, env.server.URL+"/v1/channels/"+created.ChannelID, joined.BrowserToken)
	if status != http.StatusOK || errCode != "" {
		t.Fatalf("close status/error = %d/%q, want 200", status, errCode)
	}

	status, errCode = postJSON(t, env.server.URL+"/v1/channels/"+created.ChannelID+"/messages", joined.BrowserToken, AppendMessageRequest{
		MessageID:  "msg_closed",
		Sender:     roleBrowser,
		Recipient:  roleMinter,
		Algorithm:  algorithm,
		AAD:        "aad",
		Nonce:      "nonce",
		Ciphertext: "ciphertext",
	}, nil)
	if status != http.StatusConflict || errCode != "closed" {
		t.Fatalf("closed append status/error = %d/%q, want 409/closed", status, errCode)
	}
}

func createChannel(t *testing.T, env *testEnv, shortCodeRequested bool) CreateChannelResponse {
	t.Helper()
	var response CreateChannelResponse
	status, errCode := postJSON(t, env.server.URL+"/v1/channels", "", CreateChannelRequest{
		Algorithm:          algorithm,
		MinterPublicKeyJWK: testPublicJWK,
		IdleTTLSeconds:     15,
		ShortCodeRequested: shortCodeRequested,
	}, &response)
	if status != http.StatusCreated || errCode != "" {
		t.Fatalf("create status/error = %d/%q, want 201", status, errCode)
	}
	return response
}

func joinWithPairingToken(t *testing.T, env *testEnv, created CreateChannelResponse) JoinChannelResponse {
	t.Helper()
	var response JoinChannelResponse
	status, errCode := postJSON(t, env.server.URL+"/v1/channels/"+created.ChannelID+"/join", "", JoinChannelRequest{
		PairingToken:        created.PairingToken,
		BrowserPublicKeyJWK: testPublicJWK,
		Origin:              "https://nft.example",
		BrowserInfo:         json.RawMessage(`{"name":"Chrome","userAgent":"test"}`),
	}, &response)
	if status != http.StatusCreated || errCode != "" {
		t.Fatalf("join status/error = %d/%q, want 201", status, errCode)
	}
	return response
}

func appendMessage(t *testing.T, env *testEnv, channelID, token string, req AppendMessageRequest) AppendMessageResponse {
	t.Helper()
	var response AppendMessageResponse
	status, errCode := postJSON(t, env.server.URL+"/v1/channels/"+channelID+"/messages", token, req, &response)
	if status != http.StatusCreated || errCode != "" {
		t.Fatalf("append status/error = %d/%q, want 201", status, errCode)
	}
	return response
}

func pollMessages(t *testing.T, env *testEnv, channelID, token string, afterSeq uint64) PollMessagesResponse {
	t.Helper()
	var response PollMessagesResponse
	req, err := http.NewRequest(http.MethodGet, env.server.URL+"/v1/channels/"+channelID+"/messages?afterSeq="+strconvUint(afterSeq), nil)
	if err != nil {
		t.Fatalf("new poll request: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	status, errCode := doJSON(t, req, &response)
	if status != http.StatusOK || errCode != "" {
		t.Fatalf("poll status/error = %d/%q, want 200", status, errCode)
	}
	return response
}

func channelStatus(t *testing.T, env *testEnv, channelID string) string {
	t.Helper()
	var status string
	err := env.broker.db.View(func(tx *bolt.Tx) error {
		_, metaBucket, _, _, ok := channelBuckets(tx, channelID)
		if !ok {
			return fmt.Errorf("channel %s not found", channelID)
		}
		record, err := loadChannelRecord(metaBucket)
		if err != nil {
			return err
		}
		status = record.Status
		return nil
	})
	if err != nil {
		t.Fatalf("read channel status: %v", err)
	}
	return status
}

func channelExists(t *testing.T, env *testEnv, channelID string) bool {
	t.Helper()
	var exists bool
	err := env.broker.db.View(func(tx *bolt.Tx) error {
		channels := tx.Bucket([]byte(bucketChannels))
		exists = channels != nil && channels.Bucket([]byte(channelID)) != nil
		return nil
	})
	if err != nil {
		t.Fatalf("read channel existence: %v", err)
	}
	return exists
}

func postJSON(t *testing.T, url, token string, body any, out any) (int, string) {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	return postRawJSON(t, url, token, string(raw), out)
}

func postJSONFromRemote(t *testing.T, handler http.Handler, remoteAddr, path, token string, body any, out any) (int, string) {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(raw)))
	req.RemoteAddr = remoteAddr
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	resp := recorder.Result()
	defer resp.Body.Close()
	return decodeJSONResponse(t, resp, out)
}

func postRawJSON(t *testing.T, url, token, body string, out any) (int, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
	if err != nil {
		t.Fatalf("new post request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	return doJSON(t, req, out)
}

func getJSON(t *testing.T, url, token string, out any) (int, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatalf("new get request: %v", err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	return doJSON(t, req, out)
}

func deleteJSON(t *testing.T, url, token string) (int, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodDelete, url, nil)
	if err != nil {
		t.Fatalf("new delete request: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	return doJSON(t, req, nil)
}

func doJSON(t *testing.T, req *http.Request, out any) (int, string) {
	t.Helper()
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("http request: %v", err)
	}
	defer resp.Body.Close()
	return decodeJSONResponse(t, resp, out)
}

func decodeJSONResponse(t *testing.T, resp *http.Response, out any) (int, string) {
	t.Helper()
	var errorBody struct {
		Error string `json:"error"`
	}
	if resp.StatusCode >= 400 {
		if err := json.NewDecoder(resp.Body).Decode(&errorBody); err != nil {
			t.Fatalf("decode error response: %v", err)
		}
		return resp.StatusCode, errorBody.Error
	}
	if out != nil {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			t.Fatalf("decode response: %v", err)
		}
	}
	return resp.StatusCode, ""
}

func strconvUint(value uint64) string {
	return strconv.FormatUint(value, 10)
}

const testSiteOrigin = "https://www.artblocks.io"

var testBrowserInfo = json.RawMessage(`{"name":"Art Blocks","label":"artblocks.io","userAgent":"test"}`)

func TestBrowserCreatedChannelHappyPath(t *testing.T) {
	for _, credential := range []string{"shortCode", "pairingToken"} {
		t.Run(credential, func(t *testing.T) {
			env := newTestEnv(t)
			created := createBrowserChannel(t, env, true)
			if created.CreatorRole != roleBrowser || !strings.HasPrefix(created.BrowserToken, "bt_") || created.MinterToken != "" {
				t.Fatalf("browser create response roles/tokens: %+v", created)
			}
			if !strings.HasPrefix(created.PairingToken, "pt_") || created.ShortCode == "" {
				t.Fatalf("browser create response omitted pairing material: %+v", created)
			}
			var qr map[string]any
			if err := json.Unmarshal(created.QRPayload, &qr); err != nil {
				t.Fatalf("decode qr payload: %v", err)
			}
			if qr["v"] != float64(2) || qr["creatorRole"] != roleBrowser || qr["origin"] != testSiteOrigin || qr["channelId"] != created.ChannelID || qr["brokerBaseUrl"] != "https://pairing.test" {
				t.Fatalf("unexpected v2 qr payload: %s", created.QRPayload)
			}
			if _, ok := qr["minterPublicKeyJwk"]; ok {
				t.Fatalf("v2 qr payload carries a minter key: %s", created.QRPayload)
			}

			waiting := pollMessages(t, env, created.ChannelID, created.BrowserToken, 0)
			if waiting.Status != statusWaiting || waiting.Peer != nil || len(waiting.Messages) != 0 {
				t.Fatalf("waiting poll = %+v", waiting)
			}

			var joined JoinChannelResponse
			var rawJoin map[string]json.RawMessage
			joinReq := JoinChannelRequest{MinterPublicKeyJWK: alternatePublicJWK}
			if credential == "shortCode" {
				var resolved ResolvePairingCodeResponse
				var rawResolve map[string]json.RawMessage
				status, errCode := postJSON(t, env.server.URL+"/v1/pairing-codes/resolve", "", ResolvePairingCodeRequest{ShortCode: created.ShortCode}, &rawResolve)
				if status != http.StatusOK || errCode != "" {
					t.Fatalf("resolve status/error = %d/%q, want 200", status, errCode)
				}
				remarshal(t, rawResolve, &resolved)
				if resolved.ChannelID != created.ChannelID || resolved.CreatorRole != roleBrowser || resolved.Origin != testSiteOrigin {
					t.Fatalf("resolved = %+v", resolved)
				}
				if !equalJSON(resolved.BrowserPublicKeyJWK, testPublicJWK) || !equalJSON(resolved.BrowserInfo, testBrowserInfo) {
					t.Fatalf("resolved browser key/info = %s / %s", resolved.BrowserPublicKeyJWK, resolved.BrowserInfo)
				}
				if _, ok := rawResolve["minterPublicKeyJwk"]; ok {
					t.Fatal("resolve of a browser-created channel returned minterPublicKeyJwk")
				}
				joinReq.ShortCode = created.ShortCode
			} else {
				joinReq.PairingToken = created.PairingToken
			}
			status, errCode := postJSON(t, env.server.URL+"/v1/channels/"+created.ChannelID+"/join", "", joinReq, &rawJoin)
			if status != http.StatusCreated || errCode != "" {
				t.Fatalf("minter join status/error = %d/%q, want 201", status, errCode)
			}
			remarshal(t, rawJoin, &joined)
			if joined.Role != roleMinter || !strings.HasPrefix(joined.MinterToken, "mt_") || joined.BrowserToken != "" || joined.NextSeq != 1 {
				t.Fatalf("minter join response = %+v", joined)
			}
			if joined.Origin != testSiteOrigin || !equalJSON(joined.BrowserPublicKeyJWK, testPublicJWK) || !equalJSON(joined.BrowserInfo, testBrowserInfo) {
				t.Fatalf("minter join attested fields = %+v", joined)
			}
			if _, ok := rawJoin["minterPublicKeyJwk"]; ok {
				t.Fatal("minter join response echoed minterPublicKeyJwk")
			}

			status, errCode = postJSON(t, env.server.URL+"/v1/channels/"+created.ChannelID+"/join", "", joinReq, nil)
			if status != http.StatusUnauthorized || errCode != "unauthorized" {
				t.Fatalf("second minter join status/error = %d/%q, want 401/unauthorized", status, errCode)
			}

			browserPoll := pollMessages(t, env, created.ChannelID, created.BrowserToken, 0)
			if browserPoll.Status != statusPaired || browserPoll.Peer == nil || browserPoll.Peer.Role != roleMinter || !equalJSON(browserPoll.Peer.PublicKeyJWK, alternatePublicJWK) {
				t.Fatalf("browser poll after join = %+v", browserPoll)
			}
			minterPoll := pollMessages(t, env, created.ChannelID, joined.MinterToken, 0)
			if minterPoll.Peer == nil || minterPoll.Peer.Role != roleBrowser || !equalJSON(minterPoll.Peer.PublicKeyJWK, testPublicJWK) {
				t.Fatalf("minter poll peer = %+v", minterPoll.Peer)
			}

			mintRequest := AppendMessageRequest{
				MessageID:          "msg_mint_request",
				Sender:             roleBrowser,
				Recipient:          roleMinter,
				Algorithm:          algorithm,
				AAD:                "aad",
				Nonce:              "nonce",
				Ciphertext:         "ciphertext",
				SenderPublicKeyJWK: alternatePublicJWK,
			}
			status, errCode = postJSON(t, env.server.URL+"/v1/channels/"+created.ChannelID+"/messages", created.BrowserToken, mintRequest, nil)
			if status != http.StatusBadRequest || errCode != "invalid_request" {
				t.Fatalf("browser append with a non-create key status/error = %d/%q, want 400/invalid_request", status, errCode)
			}
			mintRequest.SenderPublicKeyJWK = testPublicJWK
			if appended := appendMessage(t, env, created.ChannelID, created.BrowserToken, mintRequest); appended.Seq != 1 {
				t.Fatalf("mint_request seq = %d, want 1", appended.Seq)
			}
			minterPoll = pollMessages(t, env, created.ChannelID, joined.MinterToken, 0)
			if len(minterPoll.Messages) != 1 || minterPoll.Messages[0].MessageID != "msg_mint_request" {
				t.Fatalf("minter poll messages = %+v", minterPoll.Messages)
			}
			if appended := appendMessage(t, env, created.ChannelID, joined.MinterToken, AppendMessageRequest{
				MessageID:          "msg_mint_result",
				Sender:             roleMinter,
				Recipient:          roleBrowser,
				Algorithm:          algorithm,
				AAD:                "aad",
				Nonce:              "nonce",
				Ciphertext:         "ciphertext",
				SenderPublicKeyJWK: alternatePublicJWK,
			}); appended.Seq != 2 {
				t.Fatalf("mint result seq = %d, want 2", appended.Seq)
			}
			browserPoll = pollMessages(t, env, created.ChannelID, created.BrowserToken, 1)
			if len(browserPoll.Messages) != 1 || browserPoll.Messages[0].MessageID != "msg_mint_result" {
				t.Fatalf("browser poll messages = %+v", browserPoll.Messages)
			}

			status, errCode = deleteJSON(t, env.server.URL+"/v1/channels/"+created.ChannelID, joined.MinterToken)
			if status != http.StatusOK || errCode != "" {
				t.Fatalf("minter close status/error = %d/%q, want 200", status, errCode)
			}
		})
	}
}

func TestBrowserCreateOriginAttestation(t *testing.T) {
	env := newTestEnv(t)
	body := func(origin string) CreateChannelRequest {
		return CreateChannelRequest{
			Algorithm:           algorithm,
			CreatorRole:         roleBrowser,
			BrowserPublicKeyJWK: testPublicJWK,
			Origin:              origin,
			IdleTTLSeconds:      15,
		}
	}
	tests := []struct {
		name         string
		headerOrigin string
		bodyOrigin   string
	}{
		{name: "origin header missing", bodyOrigin: testSiteOrigin},
		{name: "origin header missing and body origin absent"},
		{name: "body origin differs from header", headerOrigin: "https://evil.example", bodyOrigin: testSiteOrigin},
		{name: "body origin differs by trailing slash", headerOrigin: testSiteOrigin, bodyOrigin: testSiteOrigin + "/"},
		{name: "opaque null origin", headerOrigin: "null"},
		{name: "origin header with path", headerOrigin: testSiteOrigin + "/page"},
		{name: "non web scheme", headerOrigin: "chrome-extension://abcdef"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			status, errCode := postJSONWithHeaders(t, env.broker, "192.0.2.1:1000", "/v1/channels", map[string]string{"Origin": tt.headerOrigin}, body(tt.bodyOrigin), nil)
			if status != http.StatusBadRequest || errCode != "invalid_request" {
				t.Fatalf("status/error = %d/%q, want 400/invalid_request", status, errCode)
			}
		})
	}

	t.Run("body origin absent takes the header", func(t *testing.T) {
		var created CreateChannelResponse
		status, errCode := postJSONWithHeaders(t, env.broker, "192.0.2.2:1000", "/v1/channels", map[string]string{"Origin": "http://localhost:5173"}, body(""), &created)
		if status != http.StatusCreated || errCode != "" {
			t.Fatalf("status/error = %d/%q, want 201", status, errCode)
		}
		var qr struct {
			Origin string `json:"origin"`
		}
		if err := json.Unmarshal(created.QRPayload, &qr); err != nil || qr.Origin != "http://localhost:5173" {
			t.Fatalf("recorded origin = %q (%v), want header origin", qr.Origin, err)
		}
	})
}

func TestCreateRejectsWrongKeyFieldForRole(t *testing.T) {
	env := newTestEnv(t)
	key := string(testPublicJWK)
	tests := []struct {
		name string
		body string
	}{
		{name: "browser creator with minter key", body: `{"algorithm":"` + algorithm + `","creatorRole":"browser","minterPublicKeyJwk":` + key + `}`},
		{name: "browser creator with both keys", body: `{"algorithm":"` + algorithm + `","creatorRole":"browser","browserPublicKeyJwk":` + key + `,"minterPublicKeyJwk":` + key + `}`},
		{name: "browser creator key must be object", body: `{"algorithm":"` + algorithm + `","creatorRole":"browser","browserPublicKeyJwk":[]}`},
		{name: "browser info must be object", body: `{"algorithm":"` + algorithm + `","creatorRole":"browser","browserPublicKeyJwk":` + key + `,"browserInfo":"x"}`},
		{name: "browser info too large", body: `{"algorithm":"` + algorithm + `","creatorRole":"browser","browserPublicKeyJwk":` + key + `,"browserInfo":{"name":"` + strings.Repeat("x", maxBrowserInfoBytes) + `"}}`},
		{name: "minter creator with browser key", body: `{"algorithm":"` + algorithm + `","creatorRole":"minter","browserPublicKeyJwk":` + key + `}`},
		{name: "legacy creator with browser key alongside minter key", body: `{"algorithm":"` + algorithm + `","minterPublicKeyJwk":` + key + `,"browserPublicKeyJwk":` + key + `}`},
		{name: "legacy creator with origin", body: `{"algorithm":"` + algorithm + `","minterPublicKeyJwk":` + key + `,"origin":"` + testSiteOrigin + `"}`},
		{name: "unknown creator role", body: `{"algorithm":"` + algorithm + `","creatorRole":"controller","minterPublicKeyJwk":` + key + `}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			status, errCode := postRawJSONWithHeaders(t, env.broker, "192.0.2.3:1000", "/v1/channels", map[string]string{"Origin": testSiteOrigin}, tt.body, nil)
			if status != http.StatusBadRequest || errCode != "invalid_request" {
				t.Fatalf("status/error = %d/%q, want 400/invalid_request", status, errCode)
			}
		})
	}
}

func TestJoinRejectsWrongKeyFieldForChannelRole(t *testing.T) {
	env := newTestEnv(t)
	browserCreated := createBrowserChannel(t, env, true)
	minterCreated := createChannel(t, env, true)
	key := string(alternatePublicJWK)
	tests := []struct {
		name      string
		channelID string
		body      string
	}{
		{
			name:      "legacy browser join on a browser-created channel",
			channelID: browserCreated.ChannelID,
			body:      `{"pairingToken":"` + browserCreated.PairingToken + `","browserPublicKeyJwk":` + key + `,"origin":"https://nft.example"}`,
		},
		{
			name:      "minter join carrying origin",
			channelID: browserCreated.ChannelID,
			body:      `{"pairingToken":"` + browserCreated.PairingToken + `","minterPublicKeyJwk":` + key + `,"origin":"https://nft.example"}`,
		},
		{
			name:      "minter join carrying browser info",
			channelID: browserCreated.ChannelID,
			body:      `{"pairingToken":"` + browserCreated.PairingToken + `","minterPublicKeyJwk":` + key + `,"browserInfo":{"name":"x"}}`,
		},
		{
			name:      "both keys",
			channelID: browserCreated.ChannelID,
			body:      `{"pairingToken":"` + browserCreated.PairingToken + `","minterPublicKeyJwk":` + key + `,"browserPublicKeyJwk":` + key + `}`,
		},
		{
			name:      "no key",
			channelID: browserCreated.ChannelID,
			body:      `{"pairingToken":"` + browserCreated.PairingToken + `"}`,
		},
		{
			name:      "minter key on a minter-created channel",
			channelID: minterCreated.ChannelID,
			body:      `{"pairingToken":"` + minterCreated.PairingToken + `","minterPublicKeyJwk":` + key + `}`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			status, errCode := postRawJSON(t, env.server.URL+"/v1/channels/"+tt.channelID+"/join", "", tt.body, nil)
			if status != http.StatusBadRequest || errCode != "invalid_request" {
				t.Fatalf("status/error = %d/%q, want 400/invalid_request", status, errCode)
			}
		})
	}

	// None of the rejected joins consumed the pairing token.
	var joined JoinChannelResponse
	status, errCode := postJSON(t, env.server.URL+"/v1/channels/"+browserCreated.ChannelID+"/join", "", JoinChannelRequest{
		PairingToken:       browserCreated.PairingToken,
		MinterPublicKeyJWK: alternatePublicJWK,
	}, &joined)
	if status != http.StatusCreated || errCode != "" || joined.Role != roleMinter {
		t.Fatalf("valid minter join after rejections status/error/role = %d/%q/%q, want 201 minter", status, errCode, joined.Role)
	}
}

func TestBrowserCreateRateLimitPerSource(t *testing.T) {
	env := newTestEnv(t)
	req := CreateChannelRequest{
		Algorithm:           algorithm,
		CreatorRole:         roleBrowser,
		BrowserPublicKeyJWK: testPublicJWK,
		IdleTTLSeconds:      15,
	}
	headers := map[string]string{"Origin": testSiteOrigin}
	for i := 0; i < shortCodeAttemptLimit; i++ {
		status, errCode := postJSONWithHeaders(t, env.broker, "198.51.100.20:1000", "/v1/channels", headers, req, nil)
		if status != http.StatusCreated || errCode != "" {
			t.Fatalf("create %d status/error = %d/%q, want 201", i, status, errCode)
		}
	}

	env.restart(t)
	status, errCode := postJSONWithHeaders(t, env.broker, "198.51.100.20:2000", "/v1/channels", headers, req, nil)
	if status != http.StatusTooManyRequests || errCode != "rate_limited" {
		t.Fatalf("over-limit create status/error = %d/%q, want 429/rate_limited", status, errCode)
	}

	status, errCode = postJSONWithHeaders(t, env.broker, "198.51.100.21:1000", "/v1/channels", headers, req, nil)
	if status != http.StatusCreated || errCode != "" {
		t.Fatalf("create from another source status/error = %d/%q, want 201", status, errCode)
	}

	// Minter-created channels are exempt, even from a limited source.
	status, errCode = postJSONWithHeaders(t, env.broker, "198.51.100.20:3000", "/v1/channels", nil, CreateChannelRequest{
		Algorithm:          algorithm,
		MinterPublicKeyJWK: testPublicJWK,
		IdleTTLSeconds:     15,
	}, nil)
	if status != http.StatusCreated || errCode != "" {
		t.Fatalf("minter create from limited source status/error = %d/%q, want 201", status, errCode)
	}

	*env.clock = env.clock.Add(shortCodeLockout + time.Second)
	status, errCode = postJSONWithHeaders(t, env.broker, "198.51.100.20:4000", "/v1/channels", headers, req, nil)
	if status != http.StatusCreated || errCode != "" {
		t.Fatalf("create after lockout status/error = %d/%q, want 201", status, errCode)
	}
}

func TestLegacyResponsesNameRoles(t *testing.T) {
	env := newTestEnv(t)
	created := createChannel(t, env, true)
	if created.CreatorRole != roleMinter {
		t.Fatalf("legacy create creatorRole = %q, want minter", created.CreatorRole)
	}
	var resolved ResolvePairingCodeResponse
	status, errCode := postJSON(t, env.server.URL+"/v1/pairing-codes/resolve", "", ResolvePairingCodeRequest{ShortCode: created.ShortCode}, &resolved)
	if status != http.StatusOK || errCode != "" || resolved.CreatorRole != roleMinter || len(resolved.BrowserPublicKeyJWK) != 0 {
		t.Fatalf("legacy resolve = %d/%q %+v", status, errCode, resolved)
	}
	waiting := pollMessages(t, env, created.ChannelID, created.MinterToken, 0)
	if waiting.Status != statusWaiting || waiting.Peer != nil {
		t.Fatalf("legacy waiting poll = %+v", waiting)
	}
	joined := joinWithPairingToken(t, env, created)
	if joined.Role != roleBrowser || joined.MinterToken != "" || joined.Origin != "" || len(joined.BrowserInfo) != 0 {
		t.Fatalf("legacy join response = %+v", joined)
	}
	minterPoll := pollMessages(t, env, created.ChannelID, created.MinterToken, 0)
	if minterPoll.Status != statusPaired || minterPoll.Peer == nil || minterPoll.Peer.Role != roleBrowser || !equalJSON(minterPoll.Peer.PublicKeyJWK, testPublicJWK) {
		t.Fatalf("legacy minter poll after join = %+v", minterPoll)
	}
	browserPoll := pollMessages(t, env, created.ChannelID, joined.BrowserToken, 0)
	if browserPoll.Peer == nil || browserPoll.Peer.Role != roleMinter {
		t.Fatalf("legacy browser poll peer = %+v", browserPoll.Peer)
	}
}

func TestLegacyRecordWithoutCreatorRoleIsMinterCreated(t *testing.T) {
	env := newTestEnv(t)
	created := createChannel(t, env, false)
	// Rewrite the stored record the way a pre-upgrade broker wrote it.
	err := env.broker.db.Update(func(tx *bolt.Tx) error {
		_, metaBucket, _, _, _ := channelBuckets(tx, created.ChannelID)
		var raw map[string]json.RawMessage
		if err := json.Unmarshal(metaBucket.Get([]byte(recordKey)), &raw); err != nil {
			return err
		}
		delete(raw, "creatorRole")
		return putJSON(metaBucket, []byte(recordKey), raw)
	})
	if err != nil {
		t.Fatalf("rewrite record: %v", err)
	}
	joined := joinWithPairingToken(t, env, created)
	if joined.Role != roleBrowser || !bytes.Equal(joined.MinterPublicKeyJWK, testPublicJWK) {
		t.Fatalf("join of a pre-upgrade record = %+v", joined)
	}
}

func createBrowserChannel(t *testing.T, env *testEnv, shortCodeRequested bool) CreateChannelResponse {
	t.Helper()
	var response CreateChannelResponse
	status, errCode := postJSONWithHeaders(t, env.broker, "203.0.113.5:4321", "/v1/channels", map[string]string{"Origin": testSiteOrigin}, CreateChannelRequest{
		Algorithm:           algorithm,
		CreatorRole:         roleBrowser,
		BrowserPublicKeyJWK: testPublicJWK,
		Origin:              testSiteOrigin,
		BrowserInfo:         testBrowserInfo,
		IdleTTLSeconds:      15,
		ShortCodeRequested:  shortCodeRequested,
	}, &response)
	if status != http.StatusCreated || errCode != "" {
		t.Fatalf("browser create status/error = %d/%q, want 201", status, errCode)
	}
	return response
}

func postJSONWithHeaders(t *testing.T, handler http.Handler, remoteAddr, path string, headers map[string]string, body any, out any) (int, string) {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	return postRawJSONWithHeaders(t, handler, remoteAddr, path, headers, string(raw), out)
}

func postRawJSONWithHeaders(t *testing.T, handler http.Handler, remoteAddr, path string, headers map[string]string, body string, out any) (int, string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.RemoteAddr = remoteAddr
	req.Header.Set("Content-Type", "application/json")
	for name, value := range headers {
		if value != "" {
			req.Header.Set(name, value)
		}
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	resp := recorder.Result()
	defer resp.Body.Close()
	return decodeJSONResponse(t, resp, out)
}

func remarshal(t *testing.T, in any, out any) {
	t.Helper()
	raw, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("remarshal: %v", err)
	}
	if err := json.Unmarshal(raw, out); err != nil {
		t.Fatalf("remarshal decode: %v", err)
	}
}
