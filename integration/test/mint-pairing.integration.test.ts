import { execFileSync, spawn, type ChildProcessByStdio } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  decryptChannelMessage,
  encryptChannelMessage,
  exportPublicJwk,
  generateBrowserKeyPair,
  requestEphemeralSession,
  type PairingMaterial
} from "@feralfile/play";

type JoinChannelResponse = {
  channelId: string;
  role: "minter";
  minterToken: string;
  browserPublicKeyJwk: JsonWebKey;
  origin: string;
  expiresAt: string;
  nextSeq: number;
};

type BrokerMessage = {
  seq: number;
  messageId: string;
  sender: "browser" | "minter";
  recipient: "browser" | "minter";
  algorithm: "P256-HKDF-SHA256-AES-256-GCM";
  aad: string;
  nonce: string;
  ciphertext: string;
  senderPublicKeyJwk?: JsonWebKey;
};

type PollMessagesResponse = {
  channelId: string;
  expiresAt: string;
  messages: BrokerMessage[];
};

type MintRequestPlaintext = {
  v: 1;
  type: "mint_request";
  channelId: string;
  requestMessageId: string;
  origin: string;
  browserPublicKeyJwk: JsonWebKey;
};

type DockerBroker = {
  baseUrl: string;
  containerId: string;
  dataDir: string;
};

type HelperProcess = ChildProcessByStdio<null, Readable, Readable>;

const imageTag = `mint-pairing-broker-integration:${String(process.pid)}`;
const repoRoot = resolve("..");
const tempDirs: string[] = [];
const containers: string[] = [];
const helperProcesses: HelperProcess[] = [];
const testOrigin = "https://nft.example";
let previousLocationDescriptor: PropertyDescriptor | undefined;

function docker(args: string[]): string {
  return execFileSync("docker", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function dockerOptional(args: string[]): string | undefined {
  try {
    return docker(args);
  } catch {
    return undefined;
  }
}

async function waitForHealth(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL("/healthz", baseUrl));
      if (response.ok) {
        return;
      }
      lastError = new Error(`healthz returned ${String(response.status)}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw lastError instanceof Error ? lastError : new Error("broker container did not become healthy");
}

async function waitForPublishedPort(containerId: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  let lastLogs = "";
  while (Date.now() < deadline) {
    const portMapping = dockerOptional(["port", containerId, "8080/tcp"]);
    const port = portMapping?.split(":").at(-1);
    if (port !== undefined && port.length > 0) {
      return port;
    }
    lastLogs = dockerOptional(["logs", containerId]) ?? lastLogs;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`broker container did not publish 8080/tcp. logs:\n${lastLogs}`);
}

async function startBroker(dataDir?: string, hostPort?: string): Promise<DockerBroker> {
  const brokerDataDir = dataDir ?? mkdtempSync(join(tmpdir(), "mint-pairing-broker-"));
  chmodSync(brokerDataDir, 0o777);
  tempDirs.push(brokerDataDir);
  const portArg = hostPort === undefined ? "127.0.0.1::8080" : `127.0.0.1:${hostPort}:8080`;
  const containerId = docker([
    "run",
    "--rm",
    "-d",
    "-p",
    portArg,
    "-v",
    `${brokerDataDir}:/data`,
    imageTag
  ]);
  containers.push(containerId);
  const port = await waitForPublishedPort(containerId);
  const broker = {
    baseUrl: `http://127.0.0.1:${port}`,
    containerId,
    dataDir: brokerDataDir
  };
  await waitForHealth(broker.baseUrl);
  return broker;
}

function stopBroker(containerId: string): void {
  dockerOptional(["stop", containerId]);
  const index = containers.indexOf(containerId);
  if (index >= 0) {
    containers.splice(index, 1);
  }
}

function stopHelper(child: HelperProcess): void {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
  }
  const index = helperProcesses.indexOf(child);
  if (index >= 0) {
    helperProcesses.splice(index, 1);
  }
}

function waitForExit(child: HelperProcess): Promise<void> {
  return new Promise((resolveWait, reject) => {
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolveWait();
        return;
      }
      reject(new Error(`go minter helper exited with code ${String(code)} signal ${String(signal)}\n${stderr}`));
    });
  });
}

type HelperCredential = { channelId: string; pairingToken: string } | { shortCode: string };

function startGoMinterHelper(baseUrl: string, credential: HelperCredential): { child: HelperProcess; done: Promise<void> } {
  const credentialEnv = "shortCode" in credential
    ? { SHORT_CODE: credential.shortCode }
    : { CHANNEL_ID: credential.channelId, PAIRING_TOKEN: credential.pairingToken };
  const child = spawn("go", ["run", "."], {
    cwd: join(repoRoot, "integration/go-minter-helper"),
    env: { ...process.env, BROKER_BASE_URL: baseUrl, ...credentialEnv },
    stdio: ["ignore", "pipe", "pipe"]
  });
  helperProcesses.push(child);
  return { child, done: waitForExit(child) };
}

/**
 * Node's fetch does not add an Origin header; a browser does, on every
 * cross-origin POST, and the broker attests it for browser-created channels.
 * This stands in for the browser.
 */
function browserFetch(origin: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("origin", origin);
    return fetch(input, { ...init, headers });
  };
}

function credentialFromAppLink(material: PairingMaterial): { channelId: string; pairingToken: string } {
  const link = new URL(material.appLink);
  const channelId = link.searchParams.get("channel");
  const pairingToken = link.searchParams.get("token");
  if (channelId === null || pairingToken === null) {
    throw new Error("app link is missing channel or token");
  }
  return { channelId, pairingToken };
}

async function readJSON<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`request failed: ${String(response.status)}`);
  }
  return response.json() as Promise<T>;
}

async function joinAsMinter(baseUrl: string, channelId: string, pairingToken: string, minterPublicKeyJwk: JsonWebKey): Promise<JoinChannelResponse> {
  const response = await fetch(new URL(`/v1/channels/${channelId}/join`, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairingToken, minterPublicKeyJwk })
  });
  return readJSON<JoinChannelResponse>(response);
}

async function pollForBrowserRequest(input: {
  baseUrl: string;
  channelId: string;
  minterToken: string;
  minterPrivateKey: CryptoKey;
}): Promise<{ message: BrokerMessage; plaintext: MintRequestPlaintext }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const url = new URL(`/v1/channels/${input.channelId}/messages`, input.baseUrl);
    url.searchParams.set("afterSeq", "0");
    const response = await fetch(url, { headers: { authorization: `Bearer ${input.minterToken}` } });
    const body = await readJSON<PollMessagesResponse>(response);
    const message = body.messages[0];
    if (message !== undefined) {
      if (message.senderPublicKeyJwk === undefined) {
        throw new Error("browser message omitted senderPublicKeyJwk");
      }
      const plaintext = await decryptChannelMessage({
        privateKey: input.minterPrivateKey,
        peerPublicJwk: message.senderPublicKeyJwk,
        channelId: input.channelId,
        messageId: message.messageId,
        seq: message.seq,
        sender: message.sender,
        recipient: message.recipient,
        algorithm: message.algorithm,
        aad: message.aad,
        nonce: message.nonce,
        ciphertext: message.ciphertext
      });
      return { message, plaintext: plaintext as MintRequestPlaintext };
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("timed out waiting for browser mint request");
}

async function sendMintSuccess(input: {
  baseUrl: string;
  channelId: string;
  minterToken: string;
  minterPrivateKey: CryptoKey;
  minterPublicKeyJwk: JsonWebKey;
  request: MintRequestPlaintext;
}): Promise<void> {
  const encrypted = await encryptChannelMessage({
    privateKey: input.minterPrivateKey,
    senderPublicJwk: input.minterPublicKeyJwk,
    peerPublicJwk: input.request.browserPublicKeyJwk,
    channelId: input.channelId,
    messageId: "msg_minter_result",
    seq: 0,
    sender: "minter",
    recipient: "browser",
    plaintext: {
      v: 1,
      type: "mint_succeeded",
      channelId: input.channelId,
      requestMessageId: input.request.requestMessageId,
      session: {
        sessionId: "eps_integration",
        token: "integration-browser-session-token",
        expiresAt: "2030-01-01T00:00:00.000Z",
        relayerBaseUrl: "https://relayer.example"
      }
    }
  });
  const response = await fetch(new URL(`/v1/channels/${input.channelId}/messages`, input.baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.minterToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(encrypted)
  });
  expect(response.status).toBe(201);
}

beforeAll(() => {
  docker(["build", "-f", "server/Dockerfile", "-t", imageTag, "server"]);
}, 120_000);

beforeEach(() => {
  previousLocationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { origin: testOrigin }
  });
});

afterEach(() => {
  if (previousLocationDescriptor === undefined) {
    Reflect.deleteProperty(globalThis, "location");
  } else {
    Object.defineProperty(globalThis, "location", previousLocationDescriptor);
  }
  for (const containerId of [...containers]) {
    stopBroker(containerId);
  }
  for (const child of [...helperProcesses]) {
    stopHelper(child);
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

afterAll(() => {
  try {
    docker(["image", "rm", "-f", imageTag]);
  } catch {
    // The image may already be gone if Docker cleanup ran externally.
  }
});

function waitForMaterial(): { onPairingMaterial: (material: PairingMaterial) => void; material: Promise<PairingMaterial> } {
  let resolveMaterial: ((material: PairingMaterial) => void) | undefined;
  const material = new Promise<PairingMaterial>((resolveWait) => {
    resolveMaterial = resolveWait;
  });
  return {
    onPairingMaterial: (value) => {
      resolveMaterial?.(value);
    },
    material
  };
}

describe("site-initiated mint pairing integration", () => {
  it.each([
    { name: "the app link's channel and pairing token", credential: (material: PairingMaterial): HelperCredential => credentialFromAppLink(material) },
    { name: "the six-digit code", credential: (material: PairingMaterial): HelperCredential => ({ shortCode: material.shortCode }) }
  ])("the Go minter joins the browser's channel with $name and delivers the session", async ({ credential }) => {
    const broker = await startBroker();
    const pairing = waitForMaterial();
    const browserSessionPromise = requestEphemeralSession({
      brokerBaseUrl: broker.baseUrl,
      appLinkBaseUrl: "https://link.feralfile.com/pair",
      browserInfo: { name: "Integration Browser" },
      storage: false,
      pollIntervalMs: 50,
      maxWaitMs: 10_000,
      fetchImpl: browserFetch(testOrigin),
      onPairingMaterial: pairing.onPairingMaterial
    });
    const material = await pairing.material;
    expect(material.appLink).toMatch(/^https:\/\/link\.feralfile\.com\/pair\?channel=ch_[^&]+&token=pt_/);
    expect(material.shortCode).toMatch(/^[0-9]{6}$/);
    const helper = startGoMinterHelper(broker.baseUrl, credential(material));
    try {
      await expect(browserSessionPromise).resolves.toEqual({
        token: "go-integration-browser-session-token",
        sessionId: "eps_go_integration",
        expiresAt: "2030-01-01T00:00:00Z",
        relayerBaseUrl: "https://relayer.example"
      });
      await helper.done;
    } finally {
      stopHelper(helper.child);
    }
  }, 60_000);

  it("pairs through a Dockerized bbolt broker that restarts before the join and before the result", async () => {
    const firstBroker = await startBroker();
    const brokerPort = new URL(firstBroker.baseUrl).port;
    const pairing = waitForMaterial();
    let joined = false;
    const browserSessionPromise = requestEphemeralSession({
      brokerBaseUrl: firstBroker.baseUrl,
      browserInfo: { name: "Integration Browser" },
      storage: false,
      pollIntervalMs: 50,
      maxWaitMs: 10_000,
      fetchImpl: browserFetch(testOrigin),
      onPairingMaterial: pairing.onPairingMaterial,
      onPeerJoined: () => {
        joined = true;
      }
    });
    const { channelId, pairingToken } = credentialFromAppLink(await pairing.material);

    stopBroker(firstBroker.containerId);
    const broker = await startBroker(firstBroker.dataDir, brokerPort);

    const minterKeyPair = await generateBrowserKeyPair();
    const minterPublicKeyJwk = await exportPublicJwk(minterKeyPair.publicKey);
    const join = await joinAsMinter(broker.baseUrl, channelId, pairingToken, minterPublicKeyJwk);
    expect(join.role).toBe("minter");
    expect(join.origin).toBe(testOrigin);

    const { plaintext } = await pollForBrowserRequest({
      baseUrl: broker.baseUrl,
      channelId,
      minterToken: join.minterToken,
      minterPrivateKey: minterKeyPair.privateKey
    });
    expect(joined).toBe(true);
    expect(plaintext).toMatchObject({
      v: 1,
      type: "mint_request",
      channelId,
      origin: testOrigin,
      supportsPersistentSessions: true
    });
    expect(plaintext.browserPublicKeyJwk).toEqual(join.browserPublicKeyJwk);

    stopBroker(broker.containerId);
    const restartedAfterMessageBroker = await startBroker(broker.dataDir, brokerPort);

    await sendMintSuccess({
      baseUrl: restartedAfterMessageBroker.baseUrl,
      channelId,
      minterToken: join.minterToken,
      minterPrivateKey: minterKeyPair.privateKey,
      minterPublicKeyJwk,
      request: plaintext
    });

    await expect(browserSessionPromise).resolves.toEqual({
      token: "integration-browser-session-token",
      sessionId: "eps_integration",
      expiresAt: "2030-01-01T00:00:00.000Z",
      relayerBaseUrl: "https://relayer.example"
    });
  }, 60_000);

  it.each([
    { name: "no Origin header", fetchImpl: (): typeof fetch => fetch },
    { name: "an Origin header for another site", fetchImpl: (): typeof fetch => browserFetch("https://impostor.example") }
  ])("refuses a browser channel with $name", async ({ fetchImpl }) => {
    const broker = await startBroker();
    await expect(requestEphemeralSession({
      brokerBaseUrl: broker.baseUrl,
      storage: false,
      fetchImpl: fetchImpl()
    })).rejects.toThrow("channel create failed: 400");
  }, 30_000);
});
