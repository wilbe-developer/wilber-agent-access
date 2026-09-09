#!/usr/bin/env node

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

const VERSION = "0.7.2";
const DEFAULT_ENDPOINT = "https://app.wilbe.com/api/wilber/mcp";
const DEFAULT_KEYCHAIN_SERVICE = "com.wilbe.wilber-agent-access";
const DEFAULT_KEYCHAIN_ACCOUNT = "default";
const KEYCHAIN_KEY_PREFIX = "wb_key_v1_";
const META_DIRECTORY = ".wilber";
const META_FILE = "workflow.json";
const TEXT_EXTENSIONS = new Set([
  ".css", ".csv", ".html", ".js", ".json", ".jsx", ".md", ".mjs",
  ".py", ".sh", ".svg", ".toml", ".ts", ".tsx", ".txt", ".yaml", ".yml",
]);
let latestClientVersion = null;
let currentClientOperation = null;

class WilberCliError extends Error {
  constructor(message, { code = "wilber_error", status = null } = {}) {
    super(message);
    this.name = "WilberCliError";
    this.code = code;
    this.status = status;
  }
}

function endpoint() {
  return process.env.WILBER_API_URL || DEFAULT_ENDPOINT;
}

function configDirectory() {
  return process.env.WILBER_CONFIG_DIR || path.join(os.homedir(), ".config", "wilber");
}

function credentialPath() {
  return path.join(configDirectory(), "credentials.json");
}

function encryptedCredentialPath() {
  return path.join(configDirectory(), "credentials.enc.json");
}

function validatedKeychainIdentifier(value, label) {
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(value)) {
    throw new WilberCliError(`Invalid ${label}.`, {
      code: "invalid_keychain_identifier",
    });
  }
  return value;
}

function keychainService() {
  return validatedKeychainIdentifier(
    process.env.WILBER_KEYCHAIN_SERVICE || DEFAULT_KEYCHAIN_SERVICE,
    "Keychain service",
  );
}

function keychainAccount() {
  return validatedKeychainIdentifier(
    process.env.WILBER_KEYCHAIN_ACCOUNT || DEFAULT_KEYCHAIN_ACCOUNT,
    "Keychain account",
  );
}

function mediaConfigDirectory() {
  return process.env.WILBER_MEDIA_CONFIG_DIR || path.join(configDirectory(), "media");
}

function youtubeConfigDirectory() {
  return process.env.WILBER_YOUTUBE_CONFIG_DIR || path.join(os.homedir(), ".wilbe", "youtube");
}

function parseArguments(input) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (!item.startsWith("--")) {
      positional.push(item);
      continue;
    }
    const [rawKey, inlineValue] = item.slice(2).split(/=(.*)/s, 2);
    if (inlineValue !== undefined) {
      flags[rawKey] = inlineValue;
      continue;
    }
    const next = input[index + 1];
    if (next && !next.startsWith("--")) {
      flags[rawKey] = next;
      index += 1;
    } else {
      flags[rawKey] = true;
    }
  }
  return { positional, flags };
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function safeRelativePath(relativePath) {
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    relativePath.split("/").includes("..") ||
    relativePath.split("/").includes("")
  ) {
    throw new WilberCliError(`Unsafe workflow path: ${relativePath}`);
  }
  return relativePath;
}

function jsonOutput(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function line(value = "") {
  process.stdout.write(`${value}\n`);
}

function redactToken(value) {
  if (!value) return null;
  return `${value.slice(0, 12)}...${value.slice(-4)}`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function detectClientHost() {
  const override = String(process.env.WILBER_CLIENT_HOST || "").toLowerCase();
  if (["claude", "codex"].includes(override)) return override;
  if (
    process.env.CLAUDECODE ||
    process.env.CLAUDE_CODE_ENTRYPOINT ||
    process.env.CLAUDE_PLUGIN_ROOT
  ) return "claude";
  if (
    process.env.CODEX_HOME ||
    process.env.CODEX_THREAD_ID ||
    process.env.CODEX_MANAGED_BY_NPM
  ) return "codex";
  return "unknown";
}

function clientHeaders(surface, operation = currentClientOperation) {
  return {
    "X-Wilber-Client-Surface": surface,
    "X-Wilber-Client-Host": detectClientHost(),
    "X-Wilber-Client-Version": VERSION,
    ...(operation ? { "X-Wilber-Client-Operation": operation } : {}),
  };
}

function semanticVersionParts(value) {
  const match = String(value || "").match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function isNewerVersion(candidate, installed = VERSION) {
  const left = semanticVersionParts(candidate);
  const right = semanticVersionParts(installed);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}

function rememberLatestVersion(response) {
  const candidate = response.headers.get("x-wilber-latest-client-version");
  if (semanticVersionParts(candidate)) latestClientVersion = candidate;
}

function decryptMediaCredentialEnvelope({ requestId, privateKey, envelope }) {
  if (
    envelope?.version !== 1 ||
    envelope?.algorithm !== "X25519-HKDF-SHA256-AES-256-GCM"
  ) {
    throw new WilberCliError("Wilber returned an unsupported credential package.", {
      code: "unsupported_credential_package",
    });
  }
  const serverPublicKey = createPublicKey({ key: envelope.serverPublicKey, format: "jwk" });
  const sharedSecret = diffieHellman({ privateKey, publicKey: serverPublicKey });
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      sharedSecret,
      Buffer.from(requestId, "utf8"),
      Buffer.from("wilber-media-credential-handoff-v1", "utf8"),
      32,
    ),
  );
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.nonce, "base64url"),
  );
  decipher.setAAD(Buffer.from(`wilber-media-credential-handoff-v1:${requestId}`, "utf8"));
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64url"));
  try {
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8"),
    );
  } catch {
    throw new WilberCliError("The credential package could not be verified for this device.", {
      code: "credential_integrity_error",
    });
  }
}

function parseMediaAccounts(value) {
  const accounts = String(value || "opus,descript,youtube")
    .split(",")
    .map((account) => account.trim().toLowerCase())
    .filter(Boolean);
  const allowed = new Set(["opus", "descript", "youtube"]);
  if (!accounts.length || accounts.some((account) => !allowed.has(account))) {
    throw new WilberCliError("Media accounts must be opus, descript, youtube, or a comma-separated subset.");
  }
  return [...new Set(accounts)].sort();
}

async function writePrivateJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(filePath), 0o700);
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(filePath, 0o600);
}

async function installMediaCredentials(payload, accounts, force) {
  if (payload?.version !== 1 || typeof payload?.accounts !== "object") {
    throw new WilberCliError("Wilber returned an invalid credential package.");
  }
  for (const account of accounts) {
    if (!payload.accounts[account]) {
      throw new WilberCliError(`The credential package did not contain ${account}.`);
    }
  }

  const mediaJsonPath = path.join(mediaConfigDirectory(), "credentials.json");
  const mediaEnvPath = path.join(mediaConfigDirectory(), "credentials.env");
  const youtubeClientPath = path.join(youtubeConfigDirectory(), "client_secret.json");
  const youtubeTokenPath = path.join(youtubeConfigDirectory(), "token.json");
  const destinations = [];
  if (accounts.some((account) => account === "opus" || account === "descript")) {
    destinations.push(mediaJsonPath, mediaEnvPath);
  }
  if (accounts.includes("youtube")) destinations.push(youtubeClientPath, youtubeTokenPath);
  if (!force && destinations.some((destination) => existsSync(destination))) {
    throw new WilberCliError(
      "Media credentials already exist on this device. Re-run with --force to replace them.",
      { code: "credentials_already_exist" },
    );
  }

  const installed = [];
  const mediaValues = {};
  if (accounts.includes("opus")) {
    const value = payload.accounts.opus?.OPUS_API_KEY;
    if (typeof value !== "string" || !value) throw new WilberCliError("The Opus credential was invalid.");
    mediaValues.OPUS_API_KEY = value;
    installed.push("opus");
  }
  if (accounts.includes("descript")) {
    const value = payload.accounts.descript?.DESCRIPT_API_TOKEN;
    if (typeof value !== "string" || !value) throw new WilberCliError("The Descript credential was invalid.");
    mediaValues.DESCRIPT_API_TOKEN = value;
    installed.push("descript");
  }
  if (Object.keys(mediaValues).length) {
    await writePrivateJson(mediaJsonPath, { version: 1, accounts: mediaValues });
    await mkdir(mediaConfigDirectory(), { recursive: true, mode: 0o700 });
    await writeFile(
      mediaEnvPath,
      `${Object.entries(mediaValues).map(([key, value]) => `${key}=${shellQuote(value)}`).join("\n")}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await chmod(mediaEnvPath, 0o600);
  }
  if (accounts.includes("youtube")) {
    const youtube = payload.accounts.youtube;
    if (!youtube?.clientSecret || !youtube?.token) {
      throw new WilberCliError("The YouTube credential package was invalid.");
    }
    await writePrivateJson(youtubeClientPath, youtube.clientSecret);
    await writePrivateJson(youtubeTokenPath, youtube.token);
    installed.push("youtube");
  }
  return {
    accounts: installed,
    mediaEnvironment: Object.keys(mediaValues).length ? mediaEnvPath : null,
    youtubeDirectory: accounts.includes("youtube") ? youtubeConfigDirectory() : null,
  };
}

async function readHidden(promptText) {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stderr;
    let value = "";
    output.write(promptText);
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    const cleanup = () => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
    };
    const onData = (character) => {
      if (character === "\u0003") {
        cleanup();
        output.write("\n");
        reject(new WilberCliError("Authentication cancelled", { code: "cancelled" }));
        return;
      }
      if (character === "\r" || character === "\n") {
        cleanup();
        output.write("\n");
        resolve(value.trim());
        return;
      }
      if (character === "\u007f") {
        value = value.slice(0, -1);
        return;
      }
      value += character;
    };
    input.on("data", onData);
  });
}

function parseStoredCredential(value) {
  if (!value) return null;
  if (typeof value === "string") {
    if (value.startsWith("wb_live_")) {
      return { kind: "personal_token", accessToken: value };
    }
    try {
      return parseStoredCredential(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (typeof value !== "object") return null;
  if (typeof value.token === "string") {
    return { kind: "personal_token", accessToken: value.token };
  }
  if (
    value.kind === "oauth" &&
    typeof value.accessToken === "string" &&
    typeof value.refreshToken === "string" &&
    typeof value.clientId === "string" &&
    typeof value.tokenEndpoint === "string"
  ) {
    return value;
  }
  return null;
}

function encryptCredential(serialized, key) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(serialized, "utf8")),
    cipher.final(),
  ]);
  return {
    version: 1,
    algorithm: "AES-256-GCM",
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
  };
}

function readEncryptedCredential(keychainValue) {
  try {
    const encodedKey = keychainValue.slice(KEYCHAIN_KEY_PREFIX.length);
    const key = Buffer.from(encodedKey, "base64url");
    if (key.length !== 32) return null;
    const envelope = JSON.parse(readFileSync(encryptedCredentialPath(), "utf8"));
    if (envelope.version !== 1 || envelope.algorithm !== "AES-256-GCM") return null;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(envelope.nonce, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(envelope.authTag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    return parseStoredCredential(plaintext);
  } catch {
    return null;
  }
}

function inspectMacKeychainCredential() {
  if (process.platform !== "darwin") {
    return { credential: null, state: "unavailable" };
  }
  const result = spawnSync(
    "security",
    ["find-generic-password", "-a", keychainAccount(), "-s", keychainService(), "-w"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status === 44) return { credential: null, state: "missing" };
  if (result.status !== 0) return { credential: null, state: "unreadable" };
  const raw = result.stdout.trim();
  if (!raw) return { credential: null, state: "empty" };
  const credential = raw.startsWith(KEYCHAIN_KEY_PREFIX)
    ? readEncryptedCredential(raw)
    : parseStoredCredential(raw);
  return credential
    ? { credential, state: "ready" }
    : { credential: null, state: "invalid" };
}

function readMacKeychainCredential() {
  return inspectMacKeychainCredential().credential;
}

async function readFileCredential() {
  try {
    const value = JSON.parse(await readFile(credentialPath(), "utf8"));
    return parseStoredCredential(value);
  } catch {
    return null;
  }
}

function credentialsMatch(expected, actual) {
  if (!expected || !actual || expected.kind !== actual.kind) return false;
  if (expected.accessToken !== actual.accessToken) return false;
  if (expected.kind !== "oauth") return true;
  return (
    expected.refreshToken === actual.refreshToken &&
    expected.clientId === actual.clientId &&
    expected.tokenEndpoint === actual.tokenEndpoint
  );
}

function deleteMacKeychainCredential() {
  if (process.platform !== "darwin") return;
  spawnSync(
    "security",
    ["delete-generic-password", "-a", keychainAccount(), "-s", keychainService()],
    { stdio: "ignore" },
  );
}

async function writeMacKeychainSecret(secret) {
  if (
    process.platform !== "darwin" ||
    process.env.WILBER_DISABLE_KEYCHAIN === "1" ||
    !existsSync("/usr/bin/expect")
  ) {
    return false;
  }
  const expectScript = `
set timeout 30
gets stdin secret
log_user 0
spawn /usr/bin/security add-generic-password -U -a {${keychainAccount()}} -s {${keychainService()}} -l {Wilber Agent Access} -w
expect {
  -re {password data.*:} { send -- "$secret\\r"; exp_continue }
  -re {retype password.*:} { send -- "$secret\\r"; exp_continue }
  eof { catch wait result; exit [lindex $result 3] }
  timeout { exit 124 }
}
`;
  const status = await new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/expect", ["-c", expectScript], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
    child.stdin.end(`${secret}\n`);
  });
  return status.code === 0;
}

async function writeMacKeychainCredential(serialized) {
  const key = randomBytes(32);
  const keychainValue = `${KEYCHAIN_KEY_PREFIX}${key.toString("base64url")}`;
  if (!(await writeMacKeychainSecret(keychainValue))) return false;
  const keychainReadback = spawnSync(
    "security",
    ["find-generic-password", "-a", keychainAccount(), "-s", keychainService(), "-w"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (keychainReadback.status !== 0 || keychainReadback.stdout.trim() !== keychainValue) {
    deleteMacKeychainCredential();
    return false;
  }
  const destination = encryptedCredentialPath();
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    await mkdir(configDirectory(), { recursive: true, mode: 0o700 });
    await writeFile(
      temporary,
      `${JSON.stringify(encryptCredential(serialized, key), null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await chmod(temporary, 0o600);
    await rename(temporary, destination);
    await chmod(destination, 0o600);
    return true;
  } catch {
    deleteMacKeychainCredential();
    return false;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function saveCredential(credential) {
  const serialized = JSON.stringify(credential);
  const keychainWritten = await writeMacKeychainCredential(serialized);
  if (keychainWritten) {
    const inspected = inspectMacKeychainCredential();
    const stored = inspected.credential;
    if (process.env.WILBER_DEBUG === "1") {
      process.stderr.write(
        `Wilber Keychain write state: ${inspected.state}; verified: ${credentialsMatch(credential, stored)}\n`,
      );
    }
    if (credentialsMatch(credential, stored)) {
      await rm(credentialPath(), { force: true });
      return "macOS Keychain";
    }
  } else if (process.env.WILBER_DEBUG === "1" && process.platform === "darwin") {
    process.stderr.write("Wilber Keychain write did not complete; using the protected file store.\n");
  }
  if (process.platform === "darwin" && process.env.WILBER_DISABLE_KEYCHAIN !== "1") {
    deleteMacKeychainCredential();
  }
  await rm(encryptedCredentialPath(), { force: true });
  await mkdir(configDirectory(), { recursive: true, mode: 0o700 });
  await writeFile(credentialPath(), `${JSON.stringify(credential, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(credentialPath(), 0o600);
  return credentialPath();
}

async function refreshOauthCredential(credential) {
  const response = await fetch(credential.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credential.refreshToken,
      client_id: credential.clientId,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body.access_token !== "string") {
    throw new WilberCliError(
      "Your Wilber authorization has expired. Run `wilber auth login` to reconnect.",
      { code: "oauth_refresh_failed", status: response.status },
    );
  }
  const refreshed = {
    ...credential,
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : credential.refreshToken,
    expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000,
    scope: typeof body.scope === "string" ? body.scope : credential.scope,
  };
  await saveCredential(refreshed);
  return refreshed;
}

export async function resolveToken({ forceRefresh = false } = {}) {
  if (process.env.WILBER_ACCESS_TOKEN) {
    return { token: process.env.WILBER_ACCESS_TOKEN.trim(), source: "environment", kind: "personal_token" };
  }
  const keychain = inspectMacKeychainCredential();
  let credential = keychain.credential;
  let source = "macOS Keychain";
  if (!credential) {
    credential = await readFileCredential();
    source = credentialPath();
  }
  if (credential) {
    if (
      credential.kind === "oauth" &&
      (forceRefresh || !credential.expiresAt || credential.expiresAt <= Date.now() + 60_000)
    ) {
      credential = await refreshOauthCredential(credential);
    }
    return { token: credential.accessToken, source, kind: credential.kind };
  }
  if (keychain.state === "empty" || keychain.state === "invalid") {
    throw new WilberCliError(
      "Wilber found an incomplete macOS Keychain authorization. Run `wilber auth login` once to repair it.",
      { code: "keychain_credential_invalid" },
    );
  }
  if (keychain.state === "unreadable") {
    throw new WilberCliError(
      "Wilber could not read its macOS Keychain authorization. Unlock Keychain Access and try again.",
      { code: "keychain_credential_unreadable" },
    );
  }
  throw new WilberCliError(
    "Wilber is not connected. Run `wilber auth login` to authorize this device in your browser.",
    { code: "not_authenticated" },
  );
}

async function saveToken(token) {
  if (!/^wb_live_[A-Za-z0-9_-]{20,}$/.test(token)) {
    throw new WilberCliError("That does not look like a Wilber access token.", {
      code: "invalid_token_format",
    });
  }
  return saveCredential({ kind: "personal_token", token, accessToken: token, endpoint: endpoint() });
}

function protectedResourceMetadataUrl() {
  if (process.env.WILBER_OAUTH_PROTECTED_RESOURCE_URL) {
    return process.env.WILBER_OAUTH_PROTECTED_RESOURCE_URL;
  }
  const target = new URL(endpoint());
  return `${target.origin}/.well-known/oauth-protected-resource${target.pathname}`;
}

async function fetchJson(url, init, label) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new WilberCliError(`${label} failed (${response.status}).`, {
      code: "oauth_discovery_failed",
      status: response.status,
    });
  }
  return body;
}

async function discoverOauth() {
  const resource = await fetchJson(
    protectedResourceMetadataUrl(),
    { headers: { Accept: "application/json" } },
    "Wilber OAuth discovery",
  );
  const issuer = resource?.authorization_servers?.[0];
  if (typeof issuer !== "string") {
    throw new WilberCliError("Wilber did not advertise an OAuth authorization server.");
  }
  const metadata = await fetchJson(
    `${issuer.replace(/\/$/, "")}/.well-known/oauth-authorization-server`,
    { headers: { Accept: "application/json" } },
    "Wilber authorization discovery",
  );
  for (const field of ["authorization_endpoint", "token_endpoint", "registration_endpoint"]) {
    if (typeof metadata[field] !== "string") {
      throw new WilberCliError(`Wilber OAuth metadata is missing ${field}.`);
    }
  }
  return { resource, metadata };
}

function openBrowser(url) {
  if (process.env.WILBER_DISABLE_BROWSER_OPEN === "1") return false;
  const command = process.platform === "darwin"
    ? ["open", [url]]
    : process.platform === "win32"
      ? ["cmd.exe", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
  const result = spawnSync(command[0], command[1], { stdio: "ignore" });
  return result.status === 0;
}

async function beginLoopbackCallback(state) {
  let settle;
  const result = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  const server = createServer((request, response) => {
    const callback = new URL(request.url || "/", "http://127.0.0.1");
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    if (callback.pathname !== "/callback") {
      response.statusCode = 404;
      response.end("Not found");
      return;
    }
    if (callback.searchParams.get("state") !== state) {
      response.statusCode = 400;
      response.end("Wilber authorization could not be verified. You can close this window.");
      settle.reject(new WilberCliError("OAuth state verification failed.", { code: "oauth_state_mismatch" }));
      return;
    }
    const oauthError = callback.searchParams.get("error");
    const code = callback.searchParams.get("code");
    if (oauthError || !code) {
      response.statusCode = 400;
      response.end("Wilber authorization was not completed. You can close this window.");
      settle.reject(new WilberCliError(
        callback.searchParams.get("error_description") || "Wilber authorization was cancelled.",
        { code: oauthError || "oauth_cancelled" },
      ));
      return;
    }
    response.end("<!doctype html><html><body style=\"font-family:system-ui;padding:48px;color:#111827\"><h1 style=\"font-size:22px\">Wilber is connected</h1><p>You can close this window and return to your agent.</p></body></html>");
    settle.resolve(code);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const redirectUri = `http://127.0.0.1:${address.port}/callback`;
  const timeout = setTimeout(() => {
    settle.reject(new WilberCliError("Wilber authorization timed out. Run `wilber auth login` to try again.", {
      code: "oauth_timeout",
    }));
  }, Number(process.env.WILBER_OAUTH_TIMEOUT_MS || 300_000));
  let closed = false;
  const close = () => {
    clearTimeout(timeout);
    if (closed) return;
    closed = true;
    if (server.listening) server.close();
  };
  return {
    redirectUri,
    wait: () => result.finally(close),
    close,
  };
}

async function browserOauthLogin() {
  const { resource, metadata } = await discoverOauth();
  const state = randomBytes(24).toString("base64url");
  const codeVerifier = randomBytes(48).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const callback = await beginLoopbackCallback(state);
  try {
    const registration = await fetchJson(
      metadata.registration_endpoint,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_name: `Wilber CLI ${VERSION}`,
          client_uri: "https://app.wilbe.com/profile?tab=ai-access",
          redirect_uris: [callback.redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          application_type: "native",
          scope: (resource.scopes_supported || ["email"]).join(" "),
        }),
      },
      "Wilber client registration",
    );
    if (typeof registration.client_id !== "string") {
      throw new WilberCliError("Wilber did not return a client ID.");
    }
    const authorizationUrl = new URL(metadata.authorization_endpoint);
    authorizationUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: registration.client_id,
      redirect_uri: callback.redirectUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      scope: (resource.scopes_supported || ["email"]).join(" "),
    }).toString();
    line("Opening Wilbe to authorize this device...");
    if (!openBrowser(authorizationUrl.toString())) {
      line(`Open this URL in your browser:\n${authorizationUrl}`);
    }
    const code = await callback.wait();
    const tokenResponse = await fetch(metadata.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: registration.client_id,
        redirect_uri: callback.redirectUri,
        code_verifier: codeVerifier,
      }),
    });
    const tokens = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || typeof tokens.access_token !== "string" || typeof tokens.refresh_token !== "string") {
      throw new WilberCliError("Wilber could not complete the browser authorization.", {
        code: "oauth_token_exchange_failed",
        status: tokenResponse.status,
      });
    }
    const credential = {
      kind: "oauth",
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000,
      clientId: registration.client_id,
      tokenEndpoint: metadata.token_endpoint,
      issuer: metadata.issuer,
      scope: tokens.scope || (resource.scopes_supported || ["email"]).join(" "),
      endpoint: endpoint(),
    };
    const profile = await callTool("wilber_access_get", {}, credential.accessToken);
    const storedIn = await saveCredential(credential);
    return { profile, storedIn };
  } catch (error) {
    callback.close();
    throw error;
  }
}

async function deleteStoredToken() {
  deleteMacKeychainCredential();
  await Promise.all([
    rm(credentialPath(), { force: true }),
    rm(encryptedCredentialPath(), { force: true }),
  ]);
}

async function rpcRequest(method, params = {}, suppliedToken = null, options = {}) {
  async function execute(token) {
    return fetch(endpoint(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": method,
        ...(method === "tools/call" && params.name ? { "Mcp-Name": params.name } : {}),
        ...clientHeaders("cli", options.operation),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
    });
  }
  const initial = suppliedToken ? { token: suppliedToken, kind: "supplied" } : await resolveToken();
  let response = await execute(initial.token);
  if (response.status === 401 && !suppliedToken && initial.kind === "oauth") {
    const refreshed = await resolveToken({ forceRefresh: true });
    response = await execute(refreshed.token);
  }
  rememberLatestVersion(response);
  const bodyText = await response.text();
  let body = null;
  try {
    body = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    throw new WilberCliError(`Wilber returned an unreadable response (${response.status}).`, {
      code: "invalid_response",
      status: response.status,
    });
  }
  if (!response.ok) {
    throw new WilberCliError(
      body?.error?.message || body?.message || body?.error || `Wilber request failed (${response.status}).`,
      { code: body?.code || "http_error", status: response.status },
    );
  }
  if (body?.error) {
    throw new WilberCliError(body.error.message || "Wilber tool failed.", {
      code: String(body.error.code || "rpc_error"),
    });
  }
  return body?.result;
}

export async function callTool(name, argumentsValue = {}, suppliedToken = null, options = {}) {
  const result = await rpcRequest(
    "tools/call",
    { name, arguments: argumentsValue },
    suppliedToken,
    options,
  );
  if (result?.isError) {
    throw new WilberCliError(result?.content?.[0]?.text || `${name} failed.`);
  }
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const textContent = result?.content?.find((item) => item.type === "text")?.text;
  if (!textContent) return null;
  try {
    return JSON.parse(textContent);
  } catch {
    return textContent;
  }
}

async function listWorkflows() {
  return callTool("wilber_workflows_list");
}

function workflowCandidates(listing) {
  return [
    ...(listing.templates || []).map((workflow) => ({ ...workflow, kind: "template" })),
    ...(listing.drafts || []).map((workflow) => ({ ...workflow, kind: "draft" })),
  ];
}

async function resolveWorkflow(selector) {
  const listing = await listWorkflows();
  const normalized = selector.toLowerCase();
  const exact = workflowCandidates(listing).filter((workflow) =>
    [workflow.id, workflow.workflow_key, workflow.name]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase() === normalized),
  );
  if (exact.length === 1) return exact[0];
  const partial = workflowCandidates(listing).filter((workflow) =>
    [workflow.workflow_key, workflow.name]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(normalized)),
  );
  if (partial.length === 1) return partial[0];
  if (exact.length + partial.length > 1) {
    throw new WilberCliError(`Workflow selector is ambiguous: ${selector}`);
  }
  throw new WilberCliError(`Workflow not found: ${selector}`, { code: "workflow_not_found" });
}

async function ensureOutputDirectory(outputPath, force) {
  if (existsSync(outputPath)) {
    const entries = await readdir(outputPath);
    if (entries.length && !force) {
      throw new WilberCliError(
        `Output directory is not empty: ${outputPath}. Choose another directory or pass --force.`,
        { code: "directory_not_empty" },
      );
    }
    if (entries.length && force) await rm(outputPath, { recursive: true, force: true });
  }
  await mkdir(outputPath, { recursive: true });
}

async function materializePackage(workflowId, outputPath, { force = false, draftId = null } = {}) {
  const exported = await callTool("wilber_workflows_export", { id: workflowId });
  await ensureOutputDirectory(outputPath, force);
  for (const file of exported.files || []) {
    const relativePath = safeRelativePath(file.path);
    const destination = path.join(outputPath, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    const content =
      file.encoding === "utf8"
        ? Buffer.from(file.content || "", "utf8")
        : Buffer.from(file.contentBase64 || "", "base64");
    if (content.length !== file.sizeBytes || sha256(content) !== file.contentHash) {
      throw new WilberCliError(`Integrity check failed for ${relativePath}.`, {
        code: "integrity_error",
      });
    }
    await writeFile(destination, content);
  }
  const metadataDirectory = path.join(outputPath, META_DIRECTORY);
  await mkdir(metadataDirectory, { recursive: true });
  const metadata = {
    schemaVersion: 1,
    workflowId,
    draftId,
    type: exported.type,
    package: exported.package,
    exportedAt: new Date().toISOString(),
  };
  await writeFile(path.join(metadataDirectory, META_FILE), `${JSON.stringify(metadata, null, 2)}\n`);
  return { exported, metadata };
}

async function readWorkspaceMetadata(directory) {
  const absoluteDirectory = path.resolve(directory);
  let metadata;
  try {
    metadata = JSON.parse(await readFile(path.join(absoluteDirectory, META_DIRECTORY, META_FILE), "utf8"));
  } catch {
    throw new WilberCliError(
      `${absoluteDirectory} is not a Wilber workflow workspace. Fork a workflow first.`,
      { code: "not_workflow_workspace" },
    );
  }
  if (!metadata.draftId) {
    throw new WilberCliError("This is a read-only export. Use `wilber workflows fork` to create an editable draft.", {
      code: "read_only_export",
    });
  }
  return { absoluteDirectory, metadata };
}

async function walkFiles(root, current = root) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.name === META_DIRECTORY || entry.name === ".git" || entry.name === "node_modules") continue;
    const absolutePath = path.join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new WilberCliError(`Symlinks are not supported in workflow packages: ${absolutePath}`);
    }
    if (entry.isDirectory()) files.push(...(await walkFiles(root, absolutePath)));
    else if (entry.isFile()) files.push(path.relative(root, absolutePath).split(path.sep).join("/"));
  }
  return files.sort();
}

function isTextFile(filePath, buffer) {
  if (buffer.includes(0)) return false;
  if (TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return true;
  return Buffer.from(buffer.toString("utf8"), "utf8").equals(buffer);
}

async function syncWorkspace(directory) {
  const { absoluteDirectory, metadata } = await readWorkspaceMetadata(directory);
  const remote = await callTool("wilber_workflows_list_files", { id: metadata.draftId });
  const remoteByPath = new Map((remote.files || []).map((file) => [file.path, file]));
  const localPaths = await walkFiles(absoluteDirectory);
  const localSet = new Set(localPaths);
  const changes = [];

  for (const relativePath of localPaths) {
    safeRelativePath(relativePath);
    const content = await readFile(path.join(absoluteDirectory, relativePath));
    const contentHash = sha256(content);
    if (remoteByPath.get(relativePath)?.contentHash === contentHash) continue;
    if (content.length > 80_000) {
      throw new WilberCliError(`${relativePath} exceeds Wilber's 80 KB per-file edit limit.`);
    }
    const text = isTextFile(relativePath, content);
    await callTool("wilber_workflows_write_file", {
      draftId: metadata.draftId,
      path: relativePath,
      ...(text ? { content: content.toString("utf8") } : { contentBase64: content.toString("base64") }),
      mediaType: remoteByPath.get(relativePath)?.mediaType || (text ? "text/plain" : "application/octet-stream"),
      changeSummary: `CLI sync: ${relativePath}`,
    });
    changes.push({ path: relativePath, action: remoteByPath.has(relativePath) ? "updated" : "added" });
  }

  for (const relativePath of [...remoteByPath.keys()].sort()) {
    if (localSet.has(relativePath)) continue;
    await callTool("wilber_workflows_write_file", {
      draftId: metadata.draftId,
      path: relativePath,
      delete: true,
      changeSummary: `CLI sync: removed ${relativePath}`,
    });
    changes.push({ path: relativePath, action: "deleted" });
  }

  metadata.lastSyncedAt = new Date().toISOString();
  await writeFile(
    path.join(absoluteDirectory, META_DIRECTORY, META_FILE),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  return { absoluteDirectory, metadata, changes };
}

function printWorkflowList(listing) {
  const templates = listing.templates || [];
  const drafts = listing.drafts || [];
  line(`${templates.length} shared workflows`);
  for (const workflow of templates) {
    const sources = workflow.source_workflow_keys || [];
    const relationship =
      workflow.catalogue_kind === "subworkflow"
        ? `  [subflow of ${sources.join(", ")}]`
        : workflow.catalogue_kind === "composite"
          ? `  [composed from ${sources.join(", ")}]`
          : "";
    line(`  ${workflow.workflow_key || workflow.id}  ${workflow.name}${relationship}`);
  }
  if (drafts.length) {
    line(`\n${drafts.length} private drafts`);
    for (const workflow of drafts) line(`  ${workflow.id}  ${workflow.name}  (${workflow.state})`);
  }
}

async function handleAuth(action, flags) {
  if (action === "login") {
    if (flags.token) {
      throw new WilberCliError("Do not pass access tokens as command-line arguments. Run `wilber auth login` for browser authorization.");
    }
    if (flags.manual === true) {
      const token = await readHidden("Wilber personal access token: ");
      const profile = await callTool("wilber_access_get", {}, token);
      const storedIn = await saveToken(token);
      line(`Connected as ${profile.identity.displayName || profile.identity.email}.`);
      line(`Compatibility credential stored in ${storedIn}.`);
      return;
    }
    if (flags.force !== true) {
      try {
        const existing = await resolveToken();
        const profile = await callTool("wilber_access_get", {}, existing.token);
        line(`Already connected as ${profile.identity.displayName || profile.identity.email}.`);
        line("Run `wilber auth logout` first if you need to authorize a different Wilbe account.");
        return;
      } catch (error) {
        if (
          !(error instanceof WilberCliError) ||
          !["not_authenticated", "oauth_refresh_failed"].includes(error.code) &&
            ![401, 403].includes(error.status)
        ) {
          throw error;
        }
      }
    }
    const { profile, storedIn } = await browserOauthLogin();
    line(`Connected as ${profile.identity.displayName || profile.identity.email}.`);
    line(`Browser authorization stored in ${storedIn}.`);
    return;
  }
  if (action === "logout") {
    await deleteStoredToken();
    line("Wilber connection removed from this device.");
    return;
  }
  if (action === "status") {
    const auth = await resolveToken();
    const profile = await callTool("wilber_access_get");
    if (flags.json) jsonOutput({ connected: true, source: auth.source, profile });
    else {
      line(`Connected as ${profile.identity.displayName || profile.identity.email}.`);
      line(`Credential source: ${auth.source}.`);
    }
    return;
  }
  throw new WilberCliError("Usage: wilber auth <login|status|logout> (use `login --manual` only as a compatibility fallback)");
}

async function handleWorkflows(action, args, flags) {
  if (action === "list") {
    const listing = await listWorkflows();
    if (flags.json) jsonOutput(listing);
    else printWorkflowList(listing);
    return;
  }
  if (action === "inspect") {
    if (!args[0]) throw new WilberCliError("Usage: wilber workflows inspect <workflow>");
    const workflow = await resolveWorkflow(args[0]);
    const detail = await callTool("wilber_workflows_get", { id: workflow.id });
    const isComposite = detail.workflow.catalogue_kind === "composite";
    const files = isComposite
      ? null
      : await callTool("wilber_workflows_list_files", { id: workflow.id });
    if (flags.json) jsonOutput({ detail, files });
    else {
      line(detail.workflow.name);
      line(detail.workflow.summary || "");
      if (isComposite) {
        line(`Composition: ${(detail.workflow.source_workflow_keys || []).join(", ")}`);
        line("Fork or export the exact component workflow you want to adapt.");
      } else {
        line(`Source: ${files.package.sourceRepository}@${files.package.sourceCommit}`);
        line(`Package: ${files.package.packageHash} (${files.files.length} files)`);
        for (const file of files.files) line(`  ${file.path}  ${file.sizeBytes} bytes`);
      }
    }
    return;
  }
  if (action === "export") {
    if (!args[0]) throw new WilberCliError("Usage: wilber workflows export <workflow> --out <directory>");
    const workflow = await resolveWorkflow(args[0]);
    const outputPath = path.resolve(String(flags.out || workflow.workflow_key || workflow.name));
    const result = await materializePackage(workflow.id, outputPath, { force: flags.force === true });
    if (flags.json) jsonOutput({ outputPath, metadata: result.metadata });
    else line(`Exported ${result.exported.files.length} files to ${outputPath}.`);
    return;
  }
  if (action === "fork") {
    if (!args[0]) throw new WilberCliError("Usage: wilber workflows fork <workflow> --out <directory>");
    const workflow = await resolveWorkflow(args[0]);
    if (workflow.kind !== "template") throw new WilberCliError("Fork a shared workflow, not an existing draft.");
    const draft = await callTool("wilber_workflows_fork", {
      templateId: workflow.id,
      ...(flags.name ? { name: String(flags.name) } : {}),
      ...(flags.summary ? { summary: String(flags.summary) } : {}),
    });
    const outputPath = path.resolve(String(flags.out || `${workflow.workflow_key || "wilber-workflow"}-experiment`));
    const result = await materializePackage(draft.id, outputPath, {
      force: flags.force === true,
      draftId: draft.id,
    });
    if (flags.json) jsonOutput({ outputPath, draft, metadata: result.metadata });
    else {
      line(`Created a private no-effect draft and exported ${result.exported.files.length} files.`);
      line(`Workspace: ${outputPath}`);
    }
    return;
  }
  if (action === "validate") {
    if (!args[0]) throw new WilberCliError("Usage: wilber workflows validate <directory>");
    const synced = await syncWorkspace(args[0]);
    const validation = await callTool("wilber_workflows_validate", { draftId: synced.metadata.draftId });
    if (flags.json) jsonOutput({ changes: synced.changes, validation });
    else {
      line(`Synchronized ${synced.changes.length} file change${synced.changes.length === 1 ? "" : "s"}.`);
      line(validation.valid ? "Validation passed." : "Validation failed.");
      for (const error of validation.errors || []) line(`  ${error.path}: ${error.message}`);
    }
    if (!validation.valid) process.exitCode = 2;
    return;
  }
  if (action === "propose") {
    if (!args[0] || flags.yes !== true) {
      throw new WilberCliError("Proposal requires confirmation: wilber workflows propose <directory> --yes");
    }
    const synced = await syncWorkspace(args[0]);
    const validation = await callTool("wilber_workflows_validate", { draftId: synced.metadata.draftId });
    if (!validation.valid) {
      if (flags.json) jsonOutput({ changes: synced.changes, validation });
      throw new WilberCliError("Validation failed; the workflow was not proposed.");
    }
    const proposal = await callTool("wilber_workflows_propose", { draftId: synced.metadata.draftId });
    if (flags.json) jsonOutput({ changes: synced.changes, validation, proposal });
    else line("Proposal submitted for Jesse's review. The shared workflow and live systems are unchanged.");
    return;
  }
  throw new WilberCliError("Usage: wilber workflows <list|inspect|export|fork|validate|propose>");
}

async function handleDemand(action, args, flags) {
  const campaignPageInput = (campaignId) => ({
    campaignId,
    ...(flags.query ? { query: String(flags.query) } : {}),
    ...(flags.status ? { status: String(flags.status) } : {}),
    ...(flags.lane ? { lane: String(flags.lane) } : {}),
    ...(flags.channel ? { channel: String(flags.channel) } : {}),
    ...(flags.direction ? { direction: String(flags.direction) } : {}),
    ...(flags["event-type"] ? { eventType: String(flags["event-type"]) } : {}),
    ...(flags.limit ? { limit: Number(flags.limit) } : {}),
    ...(flags.offset ? { offset: Number(flags.offset) } : {}),
  });
  if (action === "campaigns") {
    const value = await callTool("wilber_demand_campaigns");
    jsonOutput(value);
    return;
  }
  if (action === "campaign") {
    if (!args[0]) throw new WilberCliError("Usage: wilber demand campaign <campaign-id>");
    jsonOutput(await callTool("wilber_demand_get_campaign", { campaignId: args[0] }));
    return;
  }
  if (action === "search") {
    const query = args.join(" ").trim();
    if (!query) throw new WilberCliError("Usage: wilber demand search <query>");
    const value = await callTool("wilber_demand_search_people", {
      query,
      ...(flags.campaign ? { campaignId: String(flags.campaign) } : {}),
      ...(flags.grade ? { grade: String(flags.grade) } : {}),
      ...(flags.limit ? { limit: Number(flags.limit) } : {}),
    });
    jsonOutput(value);
    return;
  }
  if (action === "person") {
    if (!args[0]) throw new WilberCliError("Usage: wilber demand person <id>");
    jsonOutput(await callTool("wilber_demand_get_person", { id: args[0] }));
    return;
  }
  if (action === "person-pipeline") {
    if (!args[0]) throw new WilberCliError("Usage: wilber demand person-pipeline <id>");
    jsonOutput(await callTool("wilber_demand_get_person_pipeline", { id: args[0] }));
    return;
  }
  if (action === "campaign-events") {
    if (!args[0]) throw new WilberCliError("Usage: wilber demand campaign-events <campaign-id>");
    jsonOutput(await callTool("wilber_demand_campaign_events", campaignPageInput(args[0])));
    return;
  }
  if (action === "source-routes") {
    if (!args[0]) throw new WilberCliError("Usage: wilber demand source-routes <campaign-id>");
    jsonOutput(await callTool("wilber_demand_source_routes", campaignPageInput(args[0])));
    return;
  }
  if (action === "institutional-routes") {
    if (!args[0]) throw new WilberCliError("Usage: wilber demand institutional-routes <campaign-id>");
    jsonOutput(await callTool("wilber_demand_institutional_routes", campaignPageInput(args[0])));
    return;
  }
  if (action === "institutional-route") {
    if (!args[0] || !args[1]) {
      throw new WilberCliError("Usage: wilber demand institutional-route <campaign-id> <route-id>");
    }
    jsonOutput(await callTool("wilber_demand_get_institutional_route", {
      campaignId: args[0],
      routeId: args[1],
    }));
    return;
  }
  throw new WilberCliError("Usage: wilber demand <campaigns|campaign|search|person|person-pipeline|campaign-events|source-routes|institutional-routes|institutional-route>");
}

async function handleRequest(action, args, flags) {
  if (action === "campaign-context") {
    const question = String(flags.question || args.join(" ")).trim();
    if (!question) {
      throw new WilberCliError(
        "Usage: wilber request campaign-context --question <question> [--campaign <id>]",
      );
    }
    const campaignIds = flags.campaign
      ? String(flags.campaign).split(",").map((value) => value.trim()).filter(Boolean)
      : [];
    jsonOutput(await callTool("wilber_campaign_context_request", {
      question,
      ...(campaignIds.length ? { campaignIds } : {}),
      ...(flags["client-request-id"] ? { clientRequestId: String(flags["client-request-id"]) } : {}),
    }));
    return;
  }
  if (action === "admin-submit") {
    const workflow = String(flags.workflow || "");
    const objective = String(flags.objective || "");
    if (!workflow || !objective) {
      throw new WilberCliError(
        "Usage: wilber request admin-submit --workflow <key> --objective <objective> [--mode read_only|workflow_authorized]",
      );
    }
    const value = await callTool("wilber_admin_work_submit", {
      workflow,
      objective,
      ...(flags.mode ? { mode: String(flags.mode) } : {}),
      ...(flags.workspace ? { workspace: String(flags.workspace) } : {}),
      ...(flags["context-json"] ? { context: JSON.parse(String(flags["context-json"])) } : {}),
      ...(flags["client-request-id"] ? { clientRequestId: String(flags["client-request-id"]) } : {}),
    });
    jsonOutput(value);
    return;
  }
  if (action === "submit") {
    const capability = String(flags.capability || "");
    const objective = String(flags.objective || "");
    if (!capability || !objective) {
      throw new WilberCliError("Usage: wilber request submit --capability <type> --objective <objective>");
    }
    const value = await callTool("wilber_work_submit", {
      capability,
      objective,
      ...(flags["context-json"] ? { context: JSON.parse(String(flags["context-json"])) } : {}),
      ...(flags["workflow-draft"] ? { workflowDraftId: String(flags["workflow-draft"]) } : {}),
    });
    jsonOutput(value);
    return;
  }
  if (action === "status") {
    if (!args[0]) throw new WilberCliError("Usage: wilber request status <request-id>");
    jsonOutput(await callTool("wilber_work_status", { workId: args[0] }));
    return;
  }
  if (action === "continue") {
    const instruction = String(flags.instruction || "");
    const clientRequestId = String(flags["client-request-id"] || "");
    if (!args[0] || !instruction || !clientRequestId) {
      throw new WilberCliError(
        "Usage: wilber request continue <request-id> --instruction <text> --client-request-id <stable-id>",
      );
    }
    jsonOutput(await callTool("wilber_work_continue", {
      workId: args[0],
      instruction,
      clientRequestId,
      ...(flags["context-json"] ? { context: JSON.parse(String(flags["context-json"])) } : {}),
    }));
    return;
  }
  throw new WilberCliError("Usage: wilber request <submit|admin-submit|status|continue>");
}

async function handleMedia(action, args, flags) {
  if (action !== "credentials") {
    throw new WilberCliError("Usage: wilber media credentials <install|status>");
  }
  const operation = args[0];
  if (operation === "status") {
    const mediaJsonPath = path.join(mediaConfigDirectory(), "credentials.json");
    const youtubeTokenPath = path.join(youtubeConfigDirectory(), "token.json");
    const installed = [];
    if (existsSync(mediaJsonPath)) {
      try {
        const value = JSON.parse(await readFile(mediaJsonPath, "utf8"));
        if (value?.accounts?.OPUS_API_KEY) installed.push("opus");
        if (value?.accounts?.DESCRIPT_API_TOKEN) installed.push("descript");
      } catch {
        throw new WilberCliError("The local media credential file is unreadable.");
      }
    }
    if (existsSync(youtubeTokenPath)) installed.push("youtube");
    if (flags.json) {
      jsonOutput({ installed, mediaDirectory: mediaConfigDirectory(), youtubeDirectory: youtubeConfigDirectory() });
    } else if (installed.length) {
      line(`Media credentials installed: ${installed.join(", ")}.`);
      line(`Media configuration: ${mediaConfigDirectory()}`);
      if (installed.includes("youtube")) line(`YouTube configuration: ${youtubeConfigDirectory()}`);
    } else {
      line("No Wilber media credentials are installed on this device.");
    }
    return;
  }
  if (operation !== "install") {
    throw new WilberCliError("Usage: wilber media credentials <install|status>");
  }

  const accounts = parseMediaAccounts(flags.accounts);
  const timeoutSeconds = Number(flags.timeout || 120);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 15 || timeoutSeconds > 900) {
    throw new WilberCliError("--timeout must be between 15 and 900 seconds.");
  }
  const recipient = generateKeyPairSync("x25519");
  const clientRequestId = randomUUID();
  const requested = await callTool("wilber_media_credentials_request", {
    accounts,
    deviceName: os.hostname(),
    publicKey: recipient.publicKey.export({ format: "jwk" }),
    clientRequestId,
  });
  const requestId = requested?.handoff?.id;
  if (!requestId) throw new WilberCliError("Wilber did not create a credential handoff.");
  if (!flags.json) line("Preparing approved media credentials for this device...");

  const deadline = Date.now() + timeoutSeconds * 1000;
  let status;
  while (Date.now() < deadline) {
    status = await callTool("wilber_media_credentials_status", { requestId, acknowledge: false });
    if (["ready", "blocked", "expired", "completed"].includes(status?.state)) break;
    await sleep(2000);
  }
  if (status?.state === "blocked" || status?.state === "expired") {
    throw new WilberCliError(status.status_summary || "Media credential setup was blocked.");
  }
  if (status?.state !== "ready" || !status.sealed_payload) {
    throw new WilberCliError(
      "Media credential setup is still pending. Re-run the command in a moment.",
      { code: "credential_handoff_timeout" },
    );
  }
  const payload = decryptMediaCredentialEnvelope({
    requestId,
    privateKey: recipient.privateKey,
    envelope: status.sealed_payload,
  });
  if (payload.requestId !== requestId || new Date(payload.expiresAt).getTime() <= Date.now()) {
    throw new WilberCliError("The media credential package was not valid for this request.");
  }
  const installed = await installMediaCredentials(payload, accounts, flags.force === true);
  await callTool("wilber_media_credentials_status", { requestId, acknowledge: true });
  if (flags.json) {
    jsonOutput({ installed: true, ...installed });
  } else {
    line(`Installed: ${installed.accounts.join(", ")}.`);
    if (installed.mediaEnvironment) {
      line(`Media environment: ${installed.mediaEnvironment}`);
      line(`Load it in a shell with: set -a; source ${installed.mediaEnvironment}; set +a`);
    }
    if (installed.youtubeDirectory) line(`YouTube configuration: ${installed.youtubeDirectory}`);
    line("Credential values were not printed or stored by Wilber.");
  }
}

async function doctor(flags) {
  const auth = await resolveToken();
  const [profile, tools] = await Promise.all([
    callTool("wilber_access_get", {}, null, { operation: "doctor" }),
    rpcRequest("tools/list", {}, null, { operation: "doctor" }),
  ]);
  const result = {
    ok: true,
    version: VERSION,
    endpoint: endpoint(),
    credentialSource: auth.source,
    credential: redactToken(auth.token),
    identity: profile.identity,
    role: profile.identity.role,
    permissions: profile.permissions,
    availableTools: tools?.tools?.length || 0,
    authority: profile.authority,
    latestVersion: latestClientVersion || VERSION,
    updateAvailable: isNewerVersion(latestClientVersion),
  };
  if (flags.json) jsonOutput(result);
  else {
    line("Wilber Agent Access is ready.");
    line(`Identity: ${result.identity.displayName || result.identity.email}`);
    line(`Role: ${result.role}`);
    line(`Endpoint: ${result.endpoint}`);
    line(`Credential: ${result.credentialSource}`);
    line(`Available tools: ${result.availableTools}`);
    if (result.updateAvailable) {
      line(`Update available: ${VERSION} -> ${result.latestVersion}. Ask your agent to update Wilber Agent Access.`);
    } else {
      line(`Version: ${VERSION} (current)`);
    }
    line("External effects: disabled");
  }
}

async function updateClient(flags) {
  await rpcRequest("tools/list", {}, null, { operation: "update_check" });
  const host = detectClientHost();
  const available = latestClientVersion || VERSION;
  if (!isNewerVersion(available)) {
    const result = { updated: false, currentVersion: VERSION, latestVersion: available };
    if (flags.json) jsonOutput(result);
    else line(`Wilber Agent Access ${VERSION} is current.`);
    return;
  }
  if (flags.check) {
    const result = { updated: false, updateAvailable: true, currentVersion: VERSION, latestVersion: available, host };
    if (flags.json) jsonOutput(result);
    else line(`Wilber Agent Access ${available} is available.`);
    return;
  }
  if (!host || host === "unknown") {
    throw new WilberCliError(
      "A Wilber update is available. Ask your Claude or Codex agent to update Wilber Agent Access from the Wilbe marketplace.",
      { code: "client_host_unknown" },
    );
  }
  const commands = host === "claude"
    ? [["claude", ["plugin", "update", "wilber-agent-access@wilbe"]]]
    : [
        ["codex", ["plugin", "marketplace", "upgrade", "wilbe"]],
        ["codex", ["plugin", "add", "wilber-agent-access@wilbe"]],
      ];
  for (const [binary, argumentsValue] of commands) {
    const result = spawnSync(binary, argumentsValue, { stdio: "inherit" });
    if (result.status !== 0) {
      throw new WilberCliError("The client could not update Wilber Agent Access.", {
        code: "client_update_failed",
      });
    }
  }
  if (host === "claude") {
    line("Update installed. If Claude asks, run /reload-plugins. Otherwise it will load in your next task.");
  } else {
    line("Update installed. Open a new Codex task, then ask it to verify Wilber Agent Access.");
  }
}

function help() {
  line(`Wilber Agent Access ${VERSION}\n`);
  line("Usage:");
  line("  wilber auth <login|status|logout>  Browser authorization by default");
  line("  wilber whoami [--json]");
  line("  wilber doctor [--json]");
  line("  wilber update [--check] [--json]");
  line("  wilber workflows <list|inspect|export|fork|validate|propose>");
  line("  wilber demand <campaigns|campaign|search|person|person-pipeline|campaign-events|source-routes|institutional-routes|institutional-route>");
  line("  wilber request <campaign-context|submit|admin-submit|status|continue>");
  line("  wilber media credentials <install|status>");
}

async function proxyRequest(message) {
  async function execute(token) {
    return fetch(endpoint(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        ...(message.method ? { "Mcp-Method": message.method } : {}),
        ...(message.method === "tools/call" && message.params?.name ? { "Mcp-Name": message.params.name } : {}),
        ...clientHeaders(
          "mcp_proxy",
          message.method === "tools/call" && message.params?.name
            ? message.params.name
            : message.method,
        ),
      },
      body: JSON.stringify(message),
    });
  }
  const auth = await resolveToken();
  let response = await execute(auth.token);
  if (response.status === 401 && auth.kind === "oauth") {
    const refreshed = await resolveToken({ forceRefresh: true });
    response = await execute(refreshed.token);
  }
  rememberLatestVersion(response);
  const text = await response.text();
  if (!text) return null;
  try {
    const body = JSON.parse(text);
    if (
      message.method === "initialize" &&
      isNewerVersion(latestClientVersion) &&
      body?.result &&
      typeof body.result === "object"
    ) {
      const existing = typeof body.result.instructions === "string"
        ? `${body.result.instructions} `
        : "";
      body.result.instructions = `${existing}A Wilber Agent Access update is available. Ask the user once whether they want you to run wilber update. After updating, follow the client reload instruction before using Wilber again.`;
    }
    return body;
  } catch {
    return {
      jsonrpc: "2.0",
      id: message.id ?? null,
      error: { code: -32000, message: `Wilber returned HTTP ${response.status}` },
    };
  }
}

export async function runMcpProxy() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const rawLine of rl) {
    if (!rawLine.trim()) continue;
    let message;
    try {
      message = JSON.parse(rawLine);
      const response = await proxyRequest(message);
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: message?.id ?? null,
          error: { code: -32700, message: error instanceof Error ? error.message : "Wilber proxy error" },
        })}\n`,
      );
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { positional, flags } = parseArguments(argv);
  const [command, action, ...args] = positional;
  currentClientOperation = [command, action]
    .filter(Boolean)
    .join("_")
    .replace(/[^a-z0-9_.+-]/gi, "_")
    .slice(0, 80) || null;
  if (!command || command === "help" || flags.help) return help();
  if (command === "version" || flags.version) return line(VERSION);
  if (command === "mcp-proxy") return runMcpProxy();
  if (command === "auth") return handleAuth(action, flags);
  if (command === "whoami") {
    const profile = await callTool("wilber_access_get");
    if (flags.json) jsonOutput(profile);
    else {
      line(`${profile.identity.displayName || profile.identity.email} (${profile.identity.role})`);
      line(`Projects: ${profile.projectIds.length}`);
      line(`Permissions: ${profile.permissions.join(", ")}`);
      line("External effects: disabled");
    }
    return;
  }
  if (command === "doctor") return doctor(flags);
  if (command === "update") return updateClient(flags);
  if (command === "workflows") return handleWorkflows(action, args, flags);
  if (command === "demand") return handleDemand(action, args, flags);
  if (command === "request") return handleRequest(action, args, flags);
  if (command === "media") return handleMedia(action, args, flags);
  throw new WilberCliError(`Unknown command: ${command}. Run \`wilber help\`.`);
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntrypoint) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "Wilber command failed.";
    process.stderr.write(`Error: ${message}\n`);
    if (process.env.WILBER_DEBUG === "1" && error instanceof Error) {
      process.stderr.write(`${error.stack}\n`);
    }
    process.exitCode = error?.status === 401 || error?.status === 403 ? 3 : 1;
  });
}
