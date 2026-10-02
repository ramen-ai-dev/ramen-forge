/**
 * Schema V5 receipt verification for ingested exemplars.
 *
 * A receipt is accepted only if its Ed25519 signature over `canonical_payload`
 * verifies against the pinned ramen_pk_v1 key and the *signed* payload says
 * schema_version "5.0", kid "ramen_pk_v1", the same id, and verdict 1 (ALLOW).
 * Unsigned top-level fields are never trusted on their own; when present they
 * must agree with the signed payload.
 *
 * This proves the receipt is an authentic ALLOW verdict from ramen-ai. It does
 * not bind the receipt to the exemplar's content: payload_hash covers the
 * evaluated input string, which contributors do not send.
 */

export const RECEIPT_SCHEMA_VERSION = "5.0";
export const RECEIPT_KID = "ramen_pk_v1";
export const VERDICT_ALLOWED = 1;
export const INVALID_RECEIPT_CODE = "INVALID_CRYPTOGRAPHIC_RECEIPT";
export const INVALID_RECEIPT_MESSAGE =
  "Exemplar rejected: Every record must carry an authentic, verified Schema V5 receipt with verdict=1.";

/**
 * Raw 32-byte Ed25519 public key for ramen_pk_v1. Identical to the published
 * SPKI key MCowBQYDK2VwAyEA8iTL9lJGYn2alGn1yMWVAIqLImTpADb9CqaLhisTuto= in
 * EVALUATION_API_CONTRACT.md and @ramen-ai/node-core AUDIT_PUBLIC_KEYS.
 * Pinned here so a dependency update cannot silently change the trust root.
 */
const RAMEN_PK_V1_RAW_HEX = "f224cbf65246627d9a9469f5c8c595008a8b2264e90036fd0aa68b862b13bada";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64URL_RE = /^[A-Za-z0-9_-]+={0,2}$|^[A-Za-z0-9+/]+={0,2}$/;
const MAX_CANONICAL_PAYLOAD_BYTES = 16 * 1024;
const ALLOWED_RECEIPT_KEYS = new Set([
  "id",
  "schema_version",
  "kid",
  "signature",
  "canonical_payload",
  "verdict",
  "statutory_anchors",
  "attestation",
]);

export type ReceiptCheck = { ok: true; receiptId: string } | { ok: false; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function base64ToBytes(b64: string): Uint8Array {
  const standard = b64.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const bin = atob(standard + "=".repeat((4 - (standard.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

let publicKey: Promise<CryptoKey> | null = null;
function ramenPublicKey(): Promise<CryptoKey> {
  publicKey ??= crypto.subtle.importKey("raw", hexToBytes(RAMEN_PK_V1_RAW_HEX), { name: "Ed25519" }, false, ["verify"]);
  return publicKey;
}

export async function verifyExemplarReceipt(receipt: unknown): Promise<ReceiptCheck> {
  if (receipt === undefined || receipt === null) return { ok: false, reason: "receipt is missing" };
  if (!isPlainObject(receipt)) return { ok: false, reason: "receipt must be a JSON object" };

  const unknownKeys = Object.keys(receipt).filter((key) => !ALLOWED_RECEIPT_KEYS.has(key));
  if (unknownKeys.length > 0) return { ok: false, reason: `receipt has unknown fields: ${unknownKeys.slice(0, 10).join(", ")}` };

  const { id, schema_version: schemaVersion, kid, signature, canonical_payload: canonical } = receipt;
  if (typeof id !== "string" || !UUID_RE.test(id)) return { ok: false, reason: "receipt.id must be a UUID" };
  if (schemaVersion !== RECEIPT_SCHEMA_VERSION) return { ok: false, reason: `receipt.schema_version must be "${RECEIPT_SCHEMA_VERSION}"` };
  if (kid !== RECEIPT_KID) return { ok: false, reason: `receipt.kid must be "${RECEIPT_KID}"` };
  if (typeof signature !== "string" || signature.length < 80 || signature.length > 100 || !BASE64URL_RE.test(signature)) {
    return { ok: false, reason: "receipt.signature must be a base64 Ed25519 signature" };
  }
  if (typeof canonical !== "string" || canonical === "") return { ok: false, reason: "receipt.canonical_payload must be a non-empty string" };
  const canonicalBytes = new TextEncoder().encode(canonical);
  if (canonicalBytes.byteLength > MAX_CANONICAL_PAYLOAD_BYTES) return { ok: false, reason: "receipt.canonical_payload is too large" };

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = base64ToBytes(signature);
  } catch {
    return { ok: false, reason: "receipt.signature is not valid base64" };
  }
  if (signatureBytes.byteLength !== 64) return { ok: false, reason: "receipt.signature must decode to 64 bytes" };

  let signatureValid = false;
  try {
    signatureValid = await crypto.subtle.verify("Ed25519", await ramenPublicKey(), signatureBytes, canonicalBytes);
  } catch (error) {
    console.error("ramen-forge receipt verification error", error);
    return { ok: false, reason: "receipt signature could not be verified" };
  }
  if (!signatureValid) return { ok: false, reason: "receipt signature does not verify against ramen_pk_v1" };

  // Everything below is read from the signed bytes, not from unsigned fields.
  let signed: unknown;
  try {
    signed = JSON.parse(canonical);
  } catch {
    return { ok: false, reason: "receipt.canonical_payload is not JSON" };
  }
  if (!isPlainObject(signed)) return { ok: false, reason: "receipt.canonical_payload must be a JSON object" };
  if (signed.schema_version !== RECEIPT_SCHEMA_VERSION) return { ok: false, reason: "signed schema_version is not 5.0" };
  if (signed.kid !== RECEIPT_KID) return { ok: false, reason: "signed kid does not match ramen_pk_v1" };
  if (signed.id !== id) return { ok: false, reason: "signed id does not match receipt.id" };
  if (signed.verdict !== VERDICT_ALLOWED) return { ok: false, reason: "signed verdict is not 1 (the evaluated call was blocked)" };
  if (receipt.verdict !== undefined && receipt.verdict !== signed.verdict) {
    return { ok: false, reason: "receipt.verdict does not match the signed verdict" };
  }

  return { ok: true, receiptId: id.toLowerCase() };
}
