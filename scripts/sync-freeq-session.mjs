#!/usr/bin/env node
/**
 * Sync freeq IRC SASL session files from the local rook OAuth session.
 *
 * Reads ~/.config/rook/identity.session.json (after `rook login`),
 * verifies DPoP getSession against the PDS, and writes freeq session JSON
 * paths that agent/channels/irc.ts loads for ATPROTO-CHALLENGE pds-oauth.
 *
 * Usage (on eve VM):
 *   npx --yes @solpbc/rook login
 *   node scripts/sync-freeq-session.mjs
 *   # then restart the agent (start.sh)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = process.env.HOME ?? os.homedir();
const ROOK_SESSION =
  process.env.ROOK_SESSION_FILE ??
  path.join(HOME, ".config/rook/identity.session.json");
const ROOK_IDENTITY =
  process.env.ROOK_IDENTITY_FILE ??
  path.join(HOME, ".config/rook/identity.json");
const DEFAULT_PDS = "https://pds.eve.boxd.sh";
const DEFAULT_DID = "did:plc:fdiivi2izdgx3rl2d4qedt7n";
const DEFAULT_HANDLE = "eve.boxd.sh";

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}
function b64urlJson(obj) {
  return b64url(Buffer.from(JSON.stringify(obj)));
}
function sha256b64url(data) {
  return b64url(crypto.createHash("sha256").update(data).digest());
}

function makeDpop(jwk, method, htu, accessToken, nonce) {
  const priv = crypto.createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: jwk.x,
      y: jwk.y,
      d: jwk.d,
    },
    format: "jwk",
  });
  const pubJwk = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
  const payload = {
    jti: crypto.randomUUID(),
    htm: method,
    htu,
    iat: Math.floor(Date.now() / 1000),
    ath: sha256b64url(accessToken),
  };
  if (nonce) payload.nonce = nonce;
  const input = `${b64urlJson({ typ: "dpop+jwt", alg: "ES256", jwk: pubJwk })}.${b64urlJson(payload)}`;
  const sig = crypto.sign("sha256", Buffer.from(input, "ascii"), {
    key: priv,
    dsaEncoding: "ieee-p1363",
  });
  return `${input}.${b64url(sig)}`;
}

async function getSession(pds, accessToken, jwk, nonce) {
  const url = `${pds.replace(/\/$/, "")}/xrpc/com.atproto.server.getSession`;
  const dpop = makeDpop(jwk, "GET", url, accessToken, nonce);
  const res = await fetch(url, {
    headers: {
      Authorization: `DPoP ${accessToken}`,
      DPoP: dpop,
      Accept: "application/json",
    },
  });
  const text = await res.text();
  return {
    status: res.status,
    text,
    nonce: res.headers.get("dpop-nonce"),
  };
}

function loadRookEntry() {
  if (!fs.existsSync(ROOK_SESSION)) {
    throw new Error(
      `missing ${ROOK_SESSION} — run: npx --yes @solpbc/rook login`,
    );
  }
  const sessions = JSON.parse(fs.readFileSync(ROOK_SESSION, "utf8"));
  let did = process.env.ROOK_DID ?? DEFAULT_DID;
  let handle = process.env.ROOK_HANDLE ?? DEFAULT_HANDLE;
  let pds = process.env.ROOK_PDS ?? DEFAULT_PDS;

  if (fs.existsSync(ROOK_IDENTITY)) {
    try {
      const id = JSON.parse(fs.readFileSync(ROOK_IDENTITY, "utf8"));
      if (typeof id.did === "string") did = id.did;
      if (typeof id.handle === "string") handle = id.handle;
      if (typeof id.serviceOrigin === "string") pds = id.serviceOrigin;
    } catch {
      /* keep defaults */
    }
  }

  const entry = sessions[did];
  if (!entry?.tokenSet?.access_token || !entry?.dpopJwk?.d) {
    const keys = Object.keys(sessions);
    throw new Error(
      `no usable session for ${did} in ${ROOK_SESSION} (keys: ${keys.join(", ") || "none"}). Run: rook login`,
    );
  }

  const expiresAt = entry.tokenSet.expires_at ?? entry.tokenSet.expiresAt;
  if (expiresAt) {
    const exp = new Date(expiresAt).getTime();
    if (Number.isFinite(exp) && exp < Date.now()) {
      throw new Error(
        `rook access token expired at ${expiresAt} — run: npx --yes @solpbc/rook login`,
      );
    }
  }

  return { did, handle, pds, entry };
}

async function main() {
  const { did, handle, pds, entry } = loadRookEntry();
  const access = entry.tokenSet.access_token;
  const jwk = entry.dpopJwk;

  let r = await getSession(pds, access, jwk, null);
  let dpopNonce = r.nonce;
  if (r.status === 401 && r.nonce) {
    r = await getSession(pds, access, jwk, r.nonce);
    dpopNonce = r.nonce ?? dpopNonce;
  }
  if (r.status !== 200) {
    throw new Error(
      `getSession failed (${r.status}): ${r.text.slice(0, 200)}. Run: rook login`,
    );
  }

  const freeqSession = {
    did,
    handle,
    access_token: access,
    pds_url: pds.replace(/\/$/, ""),
    dpop_key: jwk.d,
    dpop_nonce: dpopNonce ?? null,
  };

  const targets = [
    process.env.IRC_FREEQ_SESSION,
    path.join(HOME, ".config/freeq-tui", `${handle}.session.json`),
    path.join(HOME, ".config/freeq", `${handle}.session.json`),
    path.join(HOME, ".config/freeq/eve.session.json"),
  ].filter(Boolean);

  const body = `${JSON.stringify(freeqSession, null, 2)}\n`;
  for (const t of targets) {
    fs.mkdirSync(path.dirname(t), { recursive: true });
    fs.writeFileSync(t, body, { mode: 0o600 });
    // ensure mode even if file existed
    fs.chmodSync(t, 0o600);
    console.error(`[sync-freeq-session] wrote ${t}`);
  }

  console.error(
    `[sync-freeq-session] ok did=${did} handle=${handle} expires=${entry.tokenSet.expires_at ?? entry.tokenSet.expiresAt ?? "unknown"}`,
  );
  console.log(
    JSON.stringify({
      ok: true,
      did,
      handle,
      pds,
      paths: targets,
      expires_at: entry.tokenSet.expires_at ?? entry.tokenSet.expiresAt ?? null,
    }),
  );
}

main().catch((e) => {
  console.error(`[sync-freeq-session] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
