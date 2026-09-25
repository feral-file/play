package minter

import (
	"encoding/json"
	"time"
)

const (
	// Algorithm is the current pairing cipher suite shared by browser requesters
	// and Go token minters.
	Algorithm = "P256-HKDF-SHA256-AES-256-GCM"

	messageTypeMintRequest   = "mint_request"
	messageTypeMintSucceeded = "mint_succeeded"
	messageTypeMintRejected  = "mint_rejected"

	// MaxRequestedExpiresInSeconds is the largest session lifetime a browser
	// requester may ask for: one year, the same bound the JS requester enforces
	// before it sends the request.
	MaxRequestedExpiresInSeconds = 31536000
)

// PublicJWK is a JSON/JWK-compatible P-256 public key.
type PublicJWK struct {
	KeyType string `json:"kty"`
	Curve   string `json:"crv"`
	X       string `json:"x"`
	Y       string `json:"y"`
	Ext     *bool  `json:"ext,omitempty"`
}

// StartChannelOptions configures a new temporary broker channel.
type StartChannelOptions struct {
	BrokerBaseURL      string
	IdleTTL            time.Duration
	ShortCodeRequested bool
}

// JoinChannelOptions joins a channel a browser created. Exactly one of
// PairingToken or ShortCode is set. ChannelID is required with PairingToken;
// with ShortCode the client resolves the code first.
type JoinChannelOptions struct {
	BrokerBaseURL string
	ChannelID     string
	PairingToken  string
	ShortCode     string
}

// JoinedRequester is what the broker attested at join time: the site origin
// taken from the browser's HTTP Origin header when it created the channel, and
// the requester metadata it sent with the create.
type JoinedRequester struct {
	Origin      string
	BrowserInfo BrowserInfo
}

// PairingDisplay is safe to pass to the FF1 frontend for QR/deep-link or
// short-code display.
type PairingDisplay struct {
	ChannelID string
	QRPayload []byte
	ShortCode string
	ExpiresAt time.Time
}

// BrowserInfo is requester metadata sent inside the encrypted mint request.
type BrowserInfo struct {
	Name      string `json:"name,omitempty"`
	UserAgent string `json:"userAgent,omitempty"`
	Label     string `json:"label,omitempty"`
}

// MintRequest is the decrypted browser request returned to feral-controld.
//
// SupportsPersistentSessions is false for a requester that did not declare the
// capability, including every browser client before @feralfile/play 0.3.0:
// those pages require a string expiresAt and cannot hold a session without one.
// Only a request with it set may be answered with a persistent result.
type MintRequest struct {
	ChannelID                  string
	MessageID                  string
	Seq                        int64
	Origin                     string
	BrowserInfo                BrowserInfo
	BrowserPublicKeyJWK        PublicJWK
	RequestedExpiresInSeconds  int  `json:"requestedExpiresInSeconds,omitempty"`
	SupportsPersistentSessions bool `json:"supportsPersistentSessions,omitempty"`
}

// MintResult is the host-created browser session returned to the browser only
// inside an encrypted broker message.
//
// Persistent marks a session the device owner kept until they remove it. Such a
// session has no expiry: ExpiresAt is ignored and the payload carries a null
// expiresAt.
type MintResult struct {
	SessionID      string    `json:"sessionId"`
	Token          string    `json:"token"`
	ExpiresAt      time.Time `json:"expiresAt"`
	Persistent     bool      `json:"persistent,omitempty"`
	RelayerBaseURL string    `json:"relayerBaseUrl,omitempty"`
}

// MarshalJSON writes the session payload shape: a null expiresAt for an
// owner-kept session, so a zero time never serializes as 0001-01-01.
func (result MintResult) MarshalJSON() ([]byte, error) {
	return json.Marshal(mintSessionPlaintext{
		SessionID:      result.SessionID,
		Token:          result.Token,
		ExpiresAt:      result.expiresAt(),
		Persistent:     result.Persistent,
		RelayerBaseURL: result.RelayerBaseURL,
	})
}

// UnmarshalJSON reads the session payload shape, treating a null or absent
// expiresAt as no expiry.
func (result *MintResult) UnmarshalJSON(data []byte) error {
	var session mintSessionPlaintext
	if err := json.Unmarshal(data, &session); err != nil {
		return err
	}
	*result = MintResult{
		SessionID:      session.SessionID,
		Token:          session.Token,
		Persistent:     session.Persistent,
		RelayerBaseURL: session.RelayerBaseURL,
	}
	if session.ExpiresAt != nil {
		result.ExpiresAt = *session.ExpiresAt
	}
	return nil
}

// expiresAt is nil for an owner-kept session and for a zero time.
func (result MintResult) expiresAt() *time.Time {
	if result.Persistent || result.ExpiresAt.IsZero() {
		return nil
	}
	expiresAt := result.ExpiresAt
	return &expiresAt
}

// MintRejection is an encrypted application-level rejection result.
type MintRejection struct {
	Reason    string `json:"reason,omitempty"`
	Retryable bool   `json:"retryable,omitempty"`
}

// SendMessageResult describes the broker-assigned message sequence.
type SendMessageResult struct {
	ChannelID string
	Seq       int64
	ExpiresAt time.Time
}

type encryptedMessage struct {
	Seq                 int64      `json:"seq,omitempty"`
	MessageID           string     `json:"messageId"`
	Sender              string     `json:"sender"`
	Recipient           string     `json:"recipient"`
	Algorithm           string     `json:"algorithm"`
	AAD                 string     `json:"aad"`
	Nonce               string     `json:"nonce"`
	Ciphertext          string     `json:"ciphertext"`
	SenderPublicKeyJWK  *PublicJWK `json:"senderPublicKeyJwk,omitempty"`
	BrowserPublicKeyJWK *PublicJWK `json:"browserPublicKeyJwk,omitempty"`
}

type envelopeAAD struct {
	Version   int    `json:"v"`
	ChannelID string `json:"channelId"`
	MessageID string `json:"messageId"`
	Seq       int64  `json:"seq"`
	Sender    string `json:"sender"`
	Recipient string `json:"recipient"`
	Algorithm string `json:"algorithm"`
}

type mintRequestPlaintext struct {
	Version             int         `json:"v"`
	Type                string      `json:"type"`
	ChannelID           string      `json:"channelId"`
	RequestMessageID    string      `json:"requestMessageId"`
	Origin              string      `json:"origin"`
	BrowserInfo         BrowserInfo `json:"browserInfo,omitempty"`
	BrowserPublicKeyJWK PublicJWK   `json:"browserPublicKeyJwk"`
	// RequestedExpiresInSeconds stays a json.Number so an absent field is
	// distinguishable from a sent value, and so a number the requester should
	// never have sent (fractional, or exponential like 1e+21) is rejected as a
	// bad request instead of failing the whole decode.
	RequestedExpiresInSeconds json.Number `json:"requestedExpiresInSeconds,omitempty"`
	// SupportsPersistentSessions is absent from requesters that predate
	// owner-kept sessions, so it decodes to false and they keep getting the
	// timed session shape they can parse.
	SupportsPersistentSessions bool `json:"supportsPersistentSessions,omitempty"`
}

type mintSuccessPlaintext struct {
	Version          int                  `json:"v"`
	Type             string               `json:"type"`
	ChannelID        string               `json:"channelId"`
	RequestMessageID string               `json:"requestMessageId,omitempty"`
	Session          mintSessionPlaintext `json:"session"`
}

// mintSessionPlaintext is the session shape the browser requester parses. A null
// expiresAt with persistent true is an owner-kept session that never expires.
type mintSessionPlaintext struct {
	SessionID      string     `json:"sessionId"`
	Token          string     `json:"token"`
	ExpiresAt      *time.Time `json:"expiresAt"`
	Persistent     bool       `json:"persistent,omitempty"`
	RelayerBaseURL string     `json:"relayerBaseUrl,omitempty"`
}

type mintRejectionPlaintext struct {
	Version          int    `json:"v"`
	Type             string `json:"type"`
	ChannelID        string `json:"channelId"`
	RequestMessageID string `json:"requestMessageId,omitempty"`
	Reason           string `json:"reason,omitempty"`
	Retryable        bool   `json:"retryable,omitempty"`
}

type createChannelRequest struct {
	Algorithm          string    `json:"algorithm"`
	MinterPublicKeyJWK PublicJWK `json:"minterPublicKeyJwk"`
	IdleTTLSeconds     int64     `json:"idleTtlSeconds,omitempty"`
	ShortCodeRequested bool      `json:"shortCodeRequested"`
}

type createChannelResponse struct {
	ChannelID    string          `json:"channelId"`
	MinterToken  string          `json:"minterToken"`
	PairingToken string          `json:"pairingToken"`
	ShortCode    string          `json:"shortCode"`
	ExpiresAt    time.Time       `json:"expiresAt"`
	QRPayload    json.RawMessage `json:"qrPayload"`
}

type resolvePairingCodeRequest struct {
	ShortCode string `json:"shortCode"`
}

type resolvePairingCodeResponse struct {
	ChannelID   string `json:"channelId"`
	CreatorRole string `json:"creatorRole"`
}

type joinChannelRequest struct {
	PairingToken       string    `json:"pairingToken,omitempty"`
	ShortCode          string    `json:"shortCode,omitempty"`
	MinterPublicKeyJWK PublicJWK `json:"minterPublicKeyJwk"`
}

type joinChannelResponse struct {
	ChannelID           string          `json:"channelId"`
	Role                string          `json:"role"`
	MinterToken         string          `json:"minterToken"`
	Algorithm           string          `json:"algorithm"`
	BrowserPublicKeyJWK *PublicJWK      `json:"browserPublicKeyJwk"`
	Origin              string          `json:"origin"`
	BrowserInfo         json.RawMessage `json:"browserInfo,omitempty"`
	ExpiresAt           time.Time       `json:"expiresAt"`
}

type pollMessagesResponse struct {
	ChannelID string             `json:"channelId"`
	ExpiresAt time.Time          `json:"expiresAt"`
	Messages  []encryptedMessage `json:"messages"`
}

type sendMessageResponse struct {
	ChannelID string    `json:"channelId"`
	Seq       int64     `json:"seq"`
	ExpiresAt time.Time `json:"expiresAt"`
}
