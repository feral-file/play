// Command go-minter-helper plays the Art Computer in the integration tests: it
// joins a channel the browser library created, checks the attested origin,
// and answers the mint request with a display grant for the keys it sent,
// pinned to a fixed device profile (the ffos-user fixture FF1).
package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"

	minter "github.com/feral-file/ff-art-computer-handoff/clients/ephemeral-token-minter/go"
)

const expectedOrigin = "https://nft.example"

// fixtureProfile is the public profile of FF1-FIXTURE1 from the ffos-user
// control fixtures (clients/session-recipient/js/test/fixtures/ff1-control-v1/keys.json).
var fixtureProfile = minter.DisplayGrantProfile{
	Version: 1,
	Dev:     "FF1-FIXTURE1",
	Gen:     "772x9uI4OcVjB0inn2MHLA",
	Sig:     json.RawMessage(`{"crv":"P-256","kty":"EC","x":"5jpANW8lLoNYtEBXDv2jPgpWd26B0qqVN2zZwUAfw64","y":"DT4WvFtjCo0h6XHTGMG7cmPVBYFqYFN3OYlIbUREyQg"}`),
	Enc:     json.RawMessage(`{"crv":"P-256","kty":"EC","x":"m_DDu8fTpmS9lGeEuKDUpSXiFQCwMEXEOtlqtFxn_b0","y":"T-W2r4vBsiYSbwb7_C48ZPvr9yQufQZAvWQXsMpHGCU"}`),
}

// thumbprint is the RFC 7638 thumbprint of a P-256 JWK, the grant's ctl.
func thumbprint(jwk minter.PublicJWK) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf(`{"crv":"P-256","kty":"EC","x":%q,"y":%q}`, jwk.X, jwk.Y)))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	brokerBaseURL := os.Getenv("BROKER_BASE_URL")
	if brokerBaseURL == "" {
		return errors.New("BROKER_BASE_URL is required")
	}
	opts := minter.JoinChannelOptions{
		BrokerBaseURL: brokerBaseURL,
		ChannelID:     os.Getenv("CHANNEL_ID"),
		PairingToken:  os.Getenv("PAIRING_TOKEN"),
		ShortCode:     os.Getenv("SHORT_CODE"),
	}
	if (opts.PairingToken == "") == (opts.ShortCode == "") {
		return errors.New("exactly one of PAIRING_TOKEN or SHORT_CODE is required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	channel, err := minter.NewClient(nil).JoinChannel(ctx, opts)
	if err != nil {
		return err
	}
	if got := channel.Requester().Origin; got != expectedOrigin {
		return fmt.Errorf("unexpected attested origin: %s", got)
	}

	var request *minter.MintRequest
	for {
		request, err = channel.PollMintRequest(ctx, 0)
		if err != nil {
			return err
		}
		if request != nil {
			break
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(50 * time.Millisecond):
		}
	}
	if request.Origin != expectedOrigin {
		return fmt.Errorf("unexpected request origin: %s", request.Origin)
	}
	keys, err := minter.ParseDisplayGrantKeys(request.DisplayGrant)
	if err != nil {
		return err
	}
	_, err = channel.SendMintSuccessResult(ctx, *request, minter.MintSuccess{
		DisplayGrant: &minter.DisplayGrantResult{
			Version:         1,
			Ctl:             thumbprint(keys.SigJWK),
			Profile:         fixtureProfile,
			RelayV2Endpoint: "https://relay.example",
			ExpiresAt:       time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC).Format(time.RFC3339),
		},
	})
	return err
}
