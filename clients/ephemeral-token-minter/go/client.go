package minter

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Client talks to the Mint Pairing Broker.
type Client struct {
	httpClient *http.Client
}

// NewClient creates a broker client. If httpClient is nil, http.DefaultClient is
// used.
func NewClient(httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return &Client{httpClient: httpClient}
}

// ErrOriginMismatch is returned by PollMintRequest on a joined channel when the
// decrypted mint request names a different origin from the one the broker
// attested when the browser created the channel.
var ErrOriginMismatch = errors.New("mint request origin does not match the attested channel origin")

// ErrBrowserKeyMismatch is returned by PollMintRequest on a joined channel when
// the mint request was encrypted with a browser key other than the one the
// broker returned at join.
var ErrBrowserKeyMismatch = errors.New("mint request browser public key does not match the joined channel key")

// BrokerError is a non-2xx broker response. StatusCode and Code (the broker's
// generic error code, such as "not_found", "expired", "unauthorized" or
// "rate_limited") let the host map failures without parsing the message.
type BrokerError struct {
	Method     string
	Path       string
	StatusCode int
	Code       string
}

func (e *BrokerError) Error() string {
	return fmt.Sprintf("broker %s %s failed with status %d", e.Method, e.Path, e.StatusCode)
}

// Channel is a local minter view of one broker pairing channel.
type Channel struct {
	client       *Client
	brokerBase   *url.URL
	channelID    string
	minterToken  string
	privateKey   *ecdh.PrivateKey
	publicKeyJWK PublicJWK
	display      PairingDisplay

	// expiresMu guards expiresAt: feral-controld polls and sends on a channel
	// from more than one goroutine.
	expiresMu sync.Mutex
	// expiresAt is the latest channel expiry the broker reported, at create or
	// join and then in every successful poll and send response.
	expiresAt time.Time

	// joined is set for a channel a browser created and this minter joined.
	joined           bool
	requester        JoinedRequester
	joinedBrowserJWK PublicJWK
}

// StartChannel creates a temporary broker channel and returns local channel
// state plus display material for the FF1 frontend.
func (c *Client) StartChannel(ctx context.Context, opts StartChannelOptions) (*Channel, error) {
	if strings.TrimSpace(opts.BrokerBaseURL) == "" {
		return nil, errors.New("broker base URL is required")
	}
	brokerBase, err := url.Parse(opts.BrokerBaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse broker base URL: %w", err)
	}
	privateKey, err := generatePrivateKey()
	if err != nil {
		return nil, err
	}
	publicJWK, err := publicKeyToJWK(privateKey.PublicKey())
	if err != nil {
		return nil, err
	}
	idleTTLSeconds := int64(0)
	if opts.IdleTTL > 0 {
		idleTTLSeconds = int64(opts.IdleTTL.Round(time.Second) / time.Second)
	}
	reqBody := createChannelRequest{
		Algorithm:          Algorithm,
		MinterPublicKeyJWK: publicJWK,
		IdleTTLSeconds:     idleTTLSeconds,
		ShortCodeRequested: opts.ShortCodeRequested,
	}
	var response createChannelResponse
	if err := c.doJSON(ctx, http.MethodPost, brokerBase, "/v1/channels", "", reqBody, &response); err != nil {
		return nil, err
	}
	if response.ChannelID == "" || response.MinterToken == "" {
		return nil, errors.New("broker create channel response missing channel id or minter token")
	}
	display := PairingDisplay{
		ChannelID: response.ChannelID,
		QRPayload: append([]byte(nil), response.QRPayload...),
		ShortCode: response.ShortCode,
		ExpiresAt: response.ExpiresAt,
	}
	return &Channel{
		client:       c,
		brokerBase:   brokerBase,
		channelID:    response.ChannelID,
		minterToken:  response.MinterToken,
		privateKey:   privateKey,
		publicKeyJWK: publicJWK,
		display:      display,
		expiresAt:    response.ExpiresAt,
	}, nil
}

// JoinChannel joins a channel a browser created, bringing this minter to the
// site's pairing request. It generates the minter key pair, resolves the short
// code if one is given, and joins with the minter public key. The returned
// channel polls, answers and closes exactly like a created one; it has no
// pairing display material.
func (c *Client) JoinChannel(ctx context.Context, opts JoinChannelOptions) (*Channel, error) {
	if strings.TrimSpace(opts.BrokerBaseURL) == "" {
		return nil, errors.New("broker base URL is required")
	}
	if (opts.PairingToken == "") == (opts.ShortCode == "") {
		return nil, errors.New("exactly one of pairing token or short code is required")
	}
	if opts.PairingToken != "" && opts.ChannelID == "" {
		return nil, errors.New("channel id is required with a pairing token")
	}
	if opts.ShortCode != "" && opts.ChannelID != "" {
		return nil, errors.New("channel id must be empty with a short code; the code resolves it")
	}
	brokerBase, err := url.Parse(opts.BrokerBaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse broker base URL: %w", err)
	}
	channelID := opts.ChannelID
	if opts.ShortCode != "" {
		var resolved resolvePairingCodeResponse
		if err := c.doJSON(ctx, http.MethodPost, brokerBase, "/v1/pairing-codes/resolve", "", resolvePairingCodeRequest{ShortCode: opts.ShortCode}, &resolved); err != nil {
			return nil, err
		}
		if resolved.ChannelID == "" {
			return nil, errors.New("broker resolve response missing channel id")
		}
		if resolved.CreatorRole != "browser" {
			return nil, errors.New("short code belongs to a channel a browser did not create")
		}
		channelID = resolved.ChannelID
	}
	privateKey, err := generatePrivateKey()
	if err != nil {
		return nil, err
	}
	publicJWK, err := publicKeyToJWK(privateKey.PublicKey())
	if err != nil {
		return nil, err
	}
	var response joinChannelResponse
	if err := c.doJSON(ctx, http.MethodPost, brokerBase, "/v1/channels/"+pathEscape(channelID)+"/join", "", joinChannelRequest{
		PairingToken:       opts.PairingToken,
		ShortCode:          opts.ShortCode,
		MinterPublicKeyJWK: publicJWK,
	}, &response); err != nil {
		return nil, err
	}
	if response.ChannelID != channelID || response.Role != "minter" || response.MinterToken == "" {
		return nil, errors.New("broker join response is not a minter join of the requested channel")
	}
	if response.Algorithm != Algorithm {
		return nil, fmt.Errorf("unsupported channel algorithm: %s", response.Algorithm)
	}
	if response.BrowserPublicKeyJWK == nil {
		return nil, errors.New("broker join response missing browser public key")
	}
	if _, err := jwkToPublicKey(*response.BrowserPublicKeyJWK); err != nil {
		return nil, fmt.Errorf("broker join response browser public key: %w", err)
	}
	if err := validateBrowserOrigin(response.Origin); err != nil {
		return nil, fmt.Errorf("broker join response: %w", err)
	}
	var browserInfo BrowserInfo
	if len(response.BrowserInfo) > 0 {
		if err := json.Unmarshal(response.BrowserInfo, &browserInfo); err != nil {
			return nil, fmt.Errorf("decode broker join browser info: %w", err)
		}
	}
	return &Channel{
		client:       c,
		brokerBase:   brokerBase,
		channelID:    channelID,
		minterToken:  response.MinterToken,
		privateKey:   privateKey,
		publicKeyJWK: publicJWK,
		joined:       true,
		requester: JoinedRequester{
			Origin:      response.Origin,
			BrowserInfo: browserInfo,
		},
		joinedBrowserJWK: *response.BrowserPublicKeyJWK,
		expiresAt:        response.ExpiresAt,
	}, nil
}

// Requester returns what the broker attested when this minter joined a
// browser-created channel. It is the zero value for a channel this minter
// created.
func (ch *Channel) Requester() JoinedRequester {
	return ch.requester
}

// ExpiresAt returns the latest channel expiry the broker reported: at create
// or join, then refreshed from every successful PollMintRequest and send
// response. The broker's deadline is idle-based and each accepted message moves
// it later, so this tracks the real deadline as far as this minter has seen it.
// It never moves backwards.
func (ch *Channel) ExpiresAt() time.Time {
	ch.expiresMu.Lock()
	defer ch.expiresMu.Unlock()
	return ch.expiresAt
}

// noteExpiresAt records a broker-reported expiry if it is later than the one
// held; zero and earlier values are ignored.
func (ch *Channel) noteExpiresAt(expiresAt time.Time) {
	if expiresAt.IsZero() {
		return
	}
	ch.expiresMu.Lock()
	defer ch.expiresMu.Unlock()
	if expiresAt.After(ch.expiresAt) {
		ch.expiresAt = expiresAt
	}
}

// ChannelID returns the broker channel id.
func (ch *Channel) ChannelID() string {
	return ch.channelID
}

// PairingDisplay returns a copy of the frontend-safe display material.
func (ch *Channel) PairingDisplay() PairingDisplay {
	return PairingDisplay{
		ChannelID: ch.display.ChannelID,
		QRPayload: append([]byte(nil), ch.display.QRPayload...),
		ShortCode: ch.display.ShortCode,
		ExpiresAt: ch.display.ExpiresAt,
	}
}

// MinterPublicKeyJWK returns the channel public key in JWK-compatible form.
func (ch *Channel) MinterPublicKeyJWK() PublicJWK {
	return ch.publicKeyJWK
}

// PollMintRequest fetches broker messages after afterSeq and returns the first
// decryptable browser mint request addressed to this minter.
//
// On a joined channel a request that does not match what the broker attested is
// refused: the error is ErrOriginMismatch or ErrBrowserKeyMismatch, and the
// decrypted request (channel id, message id, seq, origin, browser info, sender
// key; RequestedExpiresInSeconds unset) is returned alongside it so the host can
// answer with SendMintRejection and tell the owner which request was refused.
// The request is non-nil with an error only for those two errors, and it must
// never be treated as approved or answered with SendMintSuccess. Every other
// error returns a nil request.
func (ch *Channel) PollMintRequest(ctx context.Context, afterSeq int64) (*MintRequest, error) {
	pollPath := "/v1/channels/" + pathEscape(ch.channelID) + "/messages"
	query := url.Values{}
	query.Set("afterSeq", strconv.FormatInt(afterSeq, 10))
	var response pollMessagesResponse
	if err := ch.client.doJSON(ctx, http.MethodGet, ch.brokerBase, pollPath+"?"+query.Encode(), ch.minterToken, nil, &response); err != nil {
		return nil, err
	}
	if response.ChannelID != "" && response.ChannelID != ch.channelID {
		return nil, errors.New("broker poll response channel mismatch")
	}
	ch.noteExpiresAt(response.ExpiresAt)
	for _, message := range response.Messages {
		if message.Sender != "browser" || message.Recipient != "minter" {
			continue
		}
		remotePublicJWK, err := chooseRemotePublicJWK(message)
		if err != nil {
			return nil, err
		}
		plaintext, aad, err := decryptMessage(ch.privateKey, message, remotePublicJWK)
		if err != nil {
			return nil, err
		}
		if aad.ChannelID != ch.channelID {
			return nil, errors.New("decrypted message channel mismatch")
		}
		var decoded mintRequestPlaintext
		if err := json.Unmarshal(plaintext, &decoded); err != nil {
			return nil, fmt.Errorf("decode mint request: %w", err)
		}
		if decoded.Type != messageTypeMintRequest {
			continue
		}
		if err := validateMintRequestPlaintext(decoded, ch.channelID, message.MessageID, remotePublicJWK); err != nil {
			return nil, err
		}
		request := &MintRequest{
			ChannelID:                  ch.channelID,
			MessageID:                  message.MessageID,
			Seq:                        message.Seq,
			Origin:                     decoded.Origin,
			BrowserInfo:                decoded.BrowserInfo,
			BrowserPublicKeyJWK:        remotePublicJWK,
			SupportsPersistentSessions: decoded.SupportsPersistentSessions,
		}
		if ch.joined {
			if !publicJWKMatches(remotePublicJWK, ch.joinedBrowserJWK) {
				return request, ErrBrowserKeyMismatch
			}
			if decoded.Origin != ch.requester.Origin {
				return request, ErrOriginMismatch
			}
		}
		requestedExpiresInSeconds, err := parseRequestedExpiresInSeconds(decoded.RequestedExpiresInSeconds)
		if err != nil {
			return nil, err
		}
		request.RequestedExpiresInSeconds = requestedExpiresInSeconds
		return request, nil
	}
	return nil, nil
}

// SendMintSuccess encrypts a host-created session result for the requester.
func (ch *Channel) SendMintSuccess(ctx context.Context, request MintRequest, result MintResult) (*SendMessageResult, error) {
	if result.Token == "" {
		return nil, errors.New("mint result token is required")
	}
	if result.Persistent && !request.SupportsPersistentSessions {
		return nil, errors.New("mint result cannot be persistent: the requester did not declare supportsPersistentSessions, send a timed session instead")
	}
	if !result.Persistent && result.ExpiresAt.IsZero() {
		return nil, errors.New("mint result expiresAt is required unless the session is persistent")
	}
	return ch.sendEncryptedResult(ctx, request, mintSuccessPlaintext{
		Version:          1,
		Type:             messageTypeMintSucceeded,
		ChannelID:        ch.channelID,
		RequestMessageID: request.MessageID,
		Session: mintSessionPlaintext{
			SessionID:      result.SessionID,
			Token:          result.Token,
			ExpiresAt:      result.expiresAt(),
			Persistent:     result.Persistent,
			RelayerBaseURL: result.RelayerBaseURL,
		},
	})
}

// SendMintRejection encrypts an application-level rejection for the requester.
func (ch *Channel) SendMintRejection(ctx context.Context, request MintRequest, rejection MintRejection) (*SendMessageResult, error) {
	return ch.sendEncryptedResult(ctx, request, mintRejectionPlaintext{
		Version:          1,
		Type:             messageTypeMintRejected,
		ChannelID:        ch.channelID,
		RequestMessageID: request.MessageID,
		Reason:           rejection.Reason,
		Retryable:        rejection.Retryable,
	})
}

// Close closes the broker channel.
func (ch *Channel) Close(ctx context.Context) error {
	return ch.client.doJSON(ctx, http.MethodDelete, ch.brokerBase, "/v1/channels/"+pathEscape(ch.channelID), ch.minterToken, nil, nil)
}

func (ch *Channel) sendEncryptedResult(ctx context.Context, request MintRequest, plaintext any) (*SendMessageResult, error) {
	if request.ChannelID != ch.channelID {
		return nil, errors.New("mint request channel does not match channel")
	}
	messageID, err := randomMessageID()
	if err != nil {
		return nil, err
	}
	aad := envelopeAAD{
		Version:   1,
		ChannelID: ch.channelID,
		MessageID: messageID,
		Seq:       0,
		Sender:    "minter",
		Recipient: "browser",
		Algorithm: Algorithm,
	}
	message, err := encryptJSON(ch.privateKey, request.BrowserPublicKeyJWK, aad, plaintext)
	if err != nil {
		return nil, err
	}
	message.SenderPublicKeyJWK = &ch.publicKeyJWK
	var response sendMessageResponse
	if err := ch.client.doJSON(ctx, http.MethodPost, ch.brokerBase, "/v1/channels/"+pathEscape(ch.channelID)+"/messages", ch.minterToken, message, &response); err != nil {
		return nil, err
	}
	if response.ChannelID != "" && response.ChannelID != ch.channelID {
		return nil, errors.New("broker send response channel mismatch")
	}
	ch.noteExpiresAt(response.ExpiresAt)
	return &SendMessageResult{
		ChannelID: response.ChannelID,
		Seq:       response.Seq,
		ExpiresAt: response.ExpiresAt,
	}, nil
}

func validateMintRequestPlaintext(decoded mintRequestPlaintext, channelID string, messageID string, senderPublicJWK PublicJWK) error {
	if decoded.Version != 1 {
		return fmt.Errorf("unsupported mint request version: %d", decoded.Version)
	}
	if decoded.ChannelID == "" || decoded.ChannelID != channelID {
		return errors.New("mint request channel mismatch")
	}
	if decoded.RequestMessageID == "" || decoded.RequestMessageID != messageID {
		return errors.New("mint request message id mismatch")
	}
	if !publicJWKMatches(decoded.BrowserPublicKeyJWK, senderPublicJWK) {
		return errors.New("mint request browser public key mismatch")
	}
	if err := validateBrowserOrigin(decoded.Origin); err != nil {
		return err
	}
	return nil
}

// parseRequestedExpiresInSeconds reads the lifetime the requester asked for. An
// absent value is 0: the host picks the lifetime. A present value must be a
// whole number of seconds within the protocol bound; anything else is a bad
// request, not a decode failure.
func parseRequestedExpiresInSeconds(value json.Number) (int, error) {
	if value == "" {
		return 0, nil
	}
	seconds, err := value.Int64()
	if err != nil {
		return 0, errors.New("mint request requestedExpiresInSeconds must be a whole number of seconds")
	}
	if seconds < 1 || seconds > MaxRequestedExpiresInSeconds {
		return 0, fmt.Errorf("mint request requestedExpiresInSeconds must be from 1 to %d", MaxRequestedExpiresInSeconds)
	}
	return int(seconds), nil
}

func validateBrowserOrigin(origin string) error {
	if origin == "" {
		return errors.New("mint request missing origin")
	}
	parsed, err := url.Parse(origin)
	if err != nil {
		return fmt.Errorf("parse mint request origin: %w", err)
	}
	if !parsed.IsAbs() || parsed.Host == "" {
		return errors.New("mint request origin must be absolute")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return errors.New("mint request origin must use http or https")
	}
	if parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.RawPath != "" || parsed.Opaque != "" {
		return errors.New("mint request origin must not include credentials, path, query, or fragment")
	}
	return nil
}

func publicJWKMatches(a PublicJWK, b PublicJWK) bool {
	return a.KeyType == b.KeyType && a.Curve == b.Curve && a.X == b.X && a.Y == b.Y
}

func (c *Client) doJSON(ctx context.Context, method string, base *url.URL, requestPath string, bearerToken string, requestBody any, responseBody any) error {
	requestURL := *base
	cleanPath := requestPath
	if idx := strings.Index(requestPath, "?"); idx >= 0 {
		cleanPath = requestPath[:idx]
		requestURL.RawQuery = requestPath[idx+1:]
	}
	if strings.HasPrefix(cleanPath, "/") {
		requestURL.Path = path.Clean(cleanPath)
	} else {
		requestURL.Path = path.Join(requestURL.Path, cleanPath)
	}
	var bodyReader *bytes.Reader
	if requestBody == nil {
		bodyReader = bytes.NewReader(nil)
	} else {
		encoded, err := json.Marshal(requestBody)
		if err != nil {
			return err
		}
		bodyReader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, requestURL.String(), bodyReader)
	if err != nil {
		return err
	}
	if requestBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if bearerToken != "" {
		req.Header.Set("Authorization", "Bearer "+bearerToken)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		brokerErr := &BrokerError{Method: method, Path: requestURL.Path, StatusCode: resp.StatusCode}
		var body struct {
			Error string `json:"error"`
		}
		if json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&body) == nil {
			brokerErr.Code = body.Error
		}
		return brokerErr
	}
	if responseBody == nil || resp.StatusCode == http.StatusNoContent {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(responseBody)
}

func randomMessageID() (string, error) {
	randomBytes := make([]byte, 16)
	if _, err := rand.Read(randomBytes); err != nil {
		return "", err
	}
	return "msg_" + rawBase64.EncodeToString(randomBytes), nil
}

func pathEscape(value string) string {
	return url.PathEscape(value)
}
