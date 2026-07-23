#!/usr/bin/env node
/**
 * Mint a stream.place RTMP key for *eve's* DID and wire it into local config.
 *
 * Why not reuse the freeq/rook SASL session?
 *   rook login only grants scope `atproto`, which rookery rejects for
 *   place.stream.key writes (InsufficientScope). Stream.place keys need
 *   either `transition:generic` or `repo:place.stream.key`.
 *
 * This script re-auths headlessly via WelcomeMat (same as eve-freeq-oauth.mjs)
 * with expanded scope, then:
 *   1. Generates Secp256k1 keypair (@atproto/crypto)
 *   2. Publishes place.stream.key on eve's PDS
 *   3. Writes STREAMPLACE_STREAM_KEY to ~/.config/eve/{config,runtime}.env
 *   4. Tries OpenBao upsert (usually fails — service token is read-only)
 *
 * Usage (eve VM):
 *   node scripts/ensure-streamplace-key.mjs
 *   systemctl --user restart eve-irc-bridge.service
 *
 * Env: ROOK_IDENTITY_FILE, OPENBAO_*, STREAMPLACE_FORCE=1
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import {
  createSign,
  createHash,
  randomUUID,
  generateKeyPairSync,
} from "node:crypto";

const HOME = process.env.HOME ?? os.homedir();
const ROOK_IDENTITY =
  process.env.ROOK_IDENTITY_FILE ??
  path.join(HOME, ".config/rook/identity.json");
const EVE_CONFIG_DIR = path.join(HOME, ".config/eve");
const CONFIG_ENV = path.join(EVE_CONFIG_DIR, "config.env");
const RUNTIME_ENV = path.join(EVE_CONFIG_DIR, "runtime.env");
const KEY_STORE = path.join(EVE_CONFIG_DIR, "streamplace-key.json");
const OPENBAO_ENV = path.join(EVE_CONFIG_DIR, "openbao.env");

const SCOPE = "atproto transition:generic";

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}
function b64urlJson(obj) {
  return b64url(Buffer.from(JSON.stringify(obj)));
}
function sha256b64url(data) {
  return b64url(createHash("sha256").update(data).digest());
}
function randomStr(n = 32) {
  return b64url(crypto.randomBytes(n));
}

function loadIdentity() {
  if (!fs.existsSync(ROOK_IDENTITY)) {
    throw new Error(`missing ${ROOK_IDENTITY}`);
  }
  const id = JSON.parse(fs.readFileSync(ROOK_IDENTITY, "utf8"));
  if (!id.did || !id.handle || !id.serviceOrigin || !id.rsaPrivateKeyPem || !id.rsaPublicJwk) {
    throw new Error("identity.json missing did/handle/serviceOrigin/rsa keys");
  }
  return {
    did: id.did,
    handle: id.handle,
    pds: String(id.serviceOrigin).replace(/\/$/, ""),
    rsaPem: id.rsaPrivateKeyPem,
    rsaJwk: id.rsaPublicJwk,
  };
}

function rsaSignJwt(rsaPem, header, payload) {
  const input = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const s = createSign("RSA-SHA256");
  s.update(input);
  s.end();
  return `${input}.${b64url(s.sign(rsaPem))}`;
}

function jktRsa(jwk) {
  return sha256b64url(JSON.stringify({ e: jwk.e, kty: "RSA", n: jwk.n }));
}

/** Headless OAuth (WelcomeMat) with expanded scope for repo writes. */
async function oauthWithRepoWrite(identity) {
  const { did, handle, pds, rsaPem, rsaJwk } = identity;
  const { privateKey: ecPriv } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const ecJwkFull = ecPriv.export({ format: "jwk" });
  const ecPubJwk = { kty: "EC", crv: "P-256", x: ecJwkFull.x, y: ecJwkFull.y };

  function oauthDpop(method, htu, { nonce, accessToken } = {}) {
    const payload = {
      jti: randomUUID(),
      htm: method,
      htu,
      iat: Math.floor(Date.now() / 1000),
    };
    if (nonce) payload.nonce = nonce;
    if (accessToken) payload.ath = sha256b64url(accessToken);
    const input = `${b64urlJson({ typ: "dpop+jwt", alg: "ES256", jwk: ecPubJwk })}.${b64urlJson(payload)}`;
    const sig = crypto.sign("sha256", Buffer.from(input, "ascii"), {
      key: ecPriv,
      dsaEncoding: "ieee-p1363",
    });
    return `${input}.${b64url(sig)}`;
  }

  const codeVerifier = randomStr(32);
  const codeChallenge = sha256b64url(codeVerifier);
  const state = randomStr(16);
  const redirectUri = "http://127.0.0.1:8765/callback";
  const clientId = `http://localhost?redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(SCOPE)}`;

  // PAR
  const parUrl = `${pds}/oauth/par`;
  let parNonce;
  let requestUri;
  for (let i = 0; i < 4; i++) {
    const resp = await fetch(parUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        DPoP: oauthDpop("POST", parUrl, { nonce: parNonce }),
      },
      body: new URLSearchParams({
        client_id: clientId,
        response_type: "code",
        redirect_uri: redirectUri,
        scope: SCOPE,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        login_hint: handle,
      }),
    });
    const text = await resp.text();
    const n = resp.headers.get("dpop-nonce");
    if (resp.status === 400 && text.includes("use_dpop_nonce") && n) {
      parNonce = n;
      continue;
    }
    if (!resp.ok) throw new Error(`PAR ${resp.status}: ${text.slice(0, 300)}`);
    requestUri = JSON.parse(text).request_uri;
    parNonce = n || parNonce;
    break;
  }
  if (!requestUri) throw new Error("PAR failed");

  // Consent via WelcomeMat JWT
  const tos = await (await fetch(`${pds}/tos`)).text();
  const now = Math.floor(Date.now() / 1000);
  const wmJwt = rsaSignJwt(
    rsaPem,
    { typ: "wm+jwt", alg: "RS256" },
    {
      jti: randomUUID(),
      tos_hash: sha256b64url(tos),
      aud: pds,
      cnf: { jkt: jktRsa(rsaJwk) },
      iat: now,
    },
  );
  const authorizeUrl = new URL(`${pds}/oauth/authorize`);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("request_uri", requestUri);
  const consent = await fetch(authorizeUrl, {
    redirect: "manual",
    headers: {
      Authorization: `DPoP ${wmJwt}`,
      DPoP: rsaSignJwt(
        rsaPem,
        { typ: "dpop+jwt", alg: "RS256", jwk: rsaJwk },
        {
          jti: randomUUID(),
          htm: "GET",
          htu: `${pds}/oauth/authorize`,
          iat: now,
          ath: sha256b64url(wmJwt),
        },
      ),
    },
  });
  if (consent.status !== 302) {
    throw new Error(
      `consent ${consent.status}: ${(await consent.text()).slice(0, 300)}`,
    );
  }
  const code = new URL(consent.headers.get("location")).searchParams.get(
    "code",
  );
  if (!code) throw new Error("no authorization code");

  // Token
  const tokenUrl = `${pds}/oauth/token`;
  let tokenNonce = parNonce;
  let tokens;
  for (let i = 0; i < 4; i++) {
    const resp = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        DPoP: oauthDpop("POST", tokenUrl, { nonce: tokenNonce }),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: codeVerifier,
      }),
    });
    const text = await resp.text();
    const n = resp.headers.get("dpop-nonce");
    if (
      (resp.status === 400 || resp.status === 401) &&
      text.includes("use_dpop_nonce") &&
      n
    ) {
      tokenNonce = n;
      continue;
    }
    if (!resp.ok) throw new Error(`token ${resp.status}: ${text.slice(0, 300)}`);
    tokens = JSON.parse(text);
    tokenNonce = n || tokenNonce;
    break;
  }
  if (!tokens?.access_token) throw new Error("no access_token");

  return {
    did,
    handle,
    pds,
    accessToken: tokens.access_token,
    scope: tokens.scope ?? SCOPE,
    dpop: { oauthDpop, nonce: tokenNonce },
  };
}

async function dpopXrpc(session, method, xrpcPath, body) {
  const url = `${session.pds}/xrpc/${xrpcPath}`;
  let nonce = session.dpop.nonce;
  for (let i = 0; i < 4; i++) {
    const dpop = session.dpop.oauthDpop(method, url, {
      nonce,
      accessToken: session.accessToken,
    });
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `DPoP ${session.accessToken}`,
        DPoP: dpop,
        Accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const n = res.headers.get("dpop-nonce");
    if (
      (res.status === 400 || res.status === 401) &&
      text.includes("use_dpop_nonce") &&
      n
    ) {
      nonce = n;
      session.dpop.nonce = n;
      continue;
    }
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* ignore */
    }
    session.dpop.nonce = n || nonce;
    return { status: res.status, text, json };
  }
  throw new Error("DPoP xrpc retries exhausted");
}

function ensureAtprotoCrypto() {
  const root = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
  );
  try {
    return createRequire(path.join(root, "package.json"))("@atproto/crypto");
  } catch {
    /* install */
  }
  console.error("[ensure-streamplace-key] installing @atproto/crypto …");
  const r = spawnSync(
    "npm",
    ["install", "--no-save", "--no-package-lock", "@atproto/crypto@0.4.4"],
    { cwd: root, stdio: "inherit", env: process.env },
  );
  if (r.status !== 0) throw new Error("npm install @atproto/crypto failed");
  return createRequire(path.join(root, "package.json"))("@atproto/crypto");
}

function upsertEnvFile(filePath, vars) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let existing = "";
  try {
    existing = fs.readFileSync(filePath, "utf8");
  } catch {
    /* new */
  }
  const keys = new Set(Object.keys(vars));
  const lines = existing.split("\n").filter((l) => {
    const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    return !(m && keys.has(m[1]));
  });
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  for (const [k, v] of Object.entries(vars)) lines.push(`${k}=${v}`);
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function loadOpenBaoEnv() {
  if (!fs.existsSync(OPENBAO_ENV)) return;
  for (const line of fs.readFileSync(OPENBAO_ENV, "utf8").split("\n")) {
    const m = line.match(/^(?:export\s+)?([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2].replace(/^["']|["']$/g, "");
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}

async function tryOpenBaoWrite(streamKey, did, handle) {
  loadOpenBaoEnv();
  const A = process.env.OPENBAO_ADDR;
  const T = process.env.OPENBAO_TOKEN;
  if (!A || !T) return { ok: false, reason: "OPENBAO_ADDR/TOKEN not set" };

  const url = `${A.replace(/\/$/, "")}/v1/secret/data/ai-api-keys`;
  const get = await fetch(url, { headers: { "X-Vault-Token": T } });
  if (!get.ok) {
    return { ok: false, reason: `read HTTP ${get.status}` };
  }
  const got = await get.json();
  const data = { ...(got?.data?.data ?? {}) };
  data.STREAMPLACE_STREAM_KEY = streamKey;
  data.STREAMPLACE_STREAM_KEY_DID = did;
  data.STREAMPLACE_STREAM_KEY_HANDLE = handle;
  const put = await fetch(url, {
    method: "POST",
    headers: {
      "X-Vault-Token": T,
      "content-type": "application/json",
    },
    body: JSON.stringify({ data }),
  });
  if (!put.ok) {
    return {
      ok: false,
      reason: `write HTTP ${put.status} (token likely read-only)`,
      detail: (await put.text()).slice(0, 160),
    };
  }
  return { ok: true, path: "secret/data/ai-api-keys" };
}

async function main() {
  const force = process.env.STREAMPLACE_FORCE === "1";
  const identity = loadIdentity();

  if (!force && fs.existsSync(KEY_STORE)) {
    try {
      const prev = JSON.parse(fs.readFileSync(KEY_STORE, "utf8"));
      if (prev?.did === identity.did && prev?.privateKey && prev?.signingKey) {
        upsertEnvFile(CONFIG_ENV, {
          STREAMPLACE_STREAM_KEY: prev.privateKey,
          STREAMPLACE_RTMP_URL: "rtmps://stream.place:1935/live",
          STREAMPLACE_PUBLISH_HANDLE: identity.handle,
        });
        if (fs.existsSync(RUNTIME_ENV)) {
          upsertEnvFile(RUNTIME_ENV, {
            STREAMPLACE_STREAM_KEY: prev.privateKey,
            STREAMPLACE_RTMP_URL: "rtmps://stream.place:1935/live",
            STREAMPLACE_PUBLISH_HANDLE: identity.handle,
          });
        }
        const bao = await tryOpenBaoWrite(
          prev.privateKey,
          identity.did,
          identity.handle,
        );
        console.log(
          JSON.stringify(
            {
              ok: true,
              reused: true,
              did: identity.did,
              handle: identity.handle,
              signingKey: prev.signingKey,
              publicUrl: `https://stream.place/${identity.handle}`,
              openbao: bao,
            },
            null,
            2,
          ),
        );
        return;
      }
    } catch {
      /* mint */
    }
  }

  console.error(
    `[ensure-streamplace-key] oauth scope="${SCOPE}" as ${identity.handle} …`,
  );
  const session = await oauthWithRepoWrite(identity);
  console.error(
    `[ensure-streamplace-key] token ok scope=${session.scope ?? SCOPE}`,
  );

  const { Secp256k1Keypair, bytesToMultibase } = ensureAtprotoCrypto();
  const keypair = await Secp256k1Keypair.create({ exportable: true });
  const exportedKey = await keypair.export();
  const didBytes = new TextEncoder().encode(identity.did);
  const combinedKey = new Uint8Array([...exportedKey, ...didBytes]);
  const privateKey = bytesToMultibase(combinedKey, "base58btc");
  const signingKey = keypair.did();

  const record = {
    $type: "place.stream.key",
    signingKey,
    createdAt: new Date().toISOString(),
    createdBy: "eve ensure-streamplace-key.mjs",
  };

  const created = await dpopXrpc(
    session,
    "POST",
    "com.atproto.repo.createRecord",
    {
      repo: identity.did,
      collection: "place.stream.key",
      record,
    },
  );
  if (created.status !== 200) {
    throw new Error(
      `createRecord place.stream.key failed (${created.status}): ${created.text.slice(0, 400)}`,
    );
  }

  const store = {
    did: identity.did,
    handle: identity.handle,
    pds: identity.pds,
    signingKey,
    privateKey,
    createdAt: record.createdAt,
    uri: created.json?.uri ?? null,
    cid: created.json?.cid ?? null,
  };
  fs.mkdirSync(EVE_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(KEY_STORE, `${JSON.stringify(store, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.chmodSync(KEY_STORE, 0o600);

  upsertEnvFile(CONFIG_ENV, {
    STREAMPLACE_STREAM_KEY: privateKey,
    STREAMPLACE_RTMP_URL: "rtmps://stream.place:1935/live",
    STREAMPLACE_PUBLISH_HANDLE: identity.handle,
  });
  if (fs.existsSync(RUNTIME_ENV)) {
    upsertEnvFile(RUNTIME_ENV, {
      STREAMPLACE_STREAM_KEY: privateKey,
      STREAMPLACE_RTMP_URL: "rtmps://stream.place:1935/live",
      STREAMPLACE_PUBLISH_HANDLE: identity.handle,
    });
  }

  const bao = await tryOpenBaoWrite(
    privateKey,
    identity.did,
    identity.handle,
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        reused: false,
        did: identity.did,
        handle: identity.handle,
        signingKey,
        publicUrl: `https://stream.place/${identity.handle}`,
        recordUri: store.uri,
        config: CONFIG_ENV,
        keyStore: KEY_STORE,
        openbao: bao,
        next: [
          "systemctl --user restart eve-irc-bridge.service",
          bao.ok
            ? null
            : "OpenBao token is read-only — paste STREAMPLACE_STREAM_KEY into secret/data/ai-api-keys for durable fetch-keys, or leave local config only",
        ].filter(Boolean),
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(
    `[ensure-streamplace-key] ${e instanceof Error ? e.message : e}`,
  );
  process.exit(1);
});
