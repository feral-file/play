/**
 * Experimental relay v2 carriers (`@feralfile/play/experimental`).
 *
 * Not used by the default API or the Play on Art Computer button: production
 * Play still pairs through the Mint Pairing Broker and casts over the legacy
 * relayer. These adapters only carry protected envelopes that a caller seals
 * and verifies; FF1 refuses all plaintext on v2, and browser display grants
 * and key custody are not defined yet. Shapes may change without a major
 * version bump.
 */
export { RelayClient, decodeRelayFrame, encodeRelayFrame, relayURL } from "./relay-client.js";
export { TemporaryChannel } from "./temporary-channel.js";
