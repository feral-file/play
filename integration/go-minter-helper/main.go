// Command go-minter-helper plays the Art Computer in the integration tests: it
// joins a channel the browser library created, checks the attested origin,
// and answers the mint request with a fixed session.
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	minter "github.com/feral-file/ff-art-computer-handoff/clients/ephemeral-token-minter/go"
)

const expectedOrigin = "https://nft.example"

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
	_, err = channel.SendMintSuccess(ctx, *request, minter.MintResult{
		SessionID:      "eps_go_integration",
		Token:          "go-integration-browser-session-token",
		ExpiresAt:      time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC),
		RelayerBaseURL: "https://relayer.example",
	})
	return err
}
