//! Software licensing / "certification" gate.
//!
//! The app refuses to run without a valid, cryptographically signed license
//! file that is bound to *this* machine and carries a due date. Trust comes
//! solely from the Ed25519 signature verified against [`LICENSE_PUBLIC_KEY`]
//! embedded below — the license file itself lives in the user-writable app-data
//! directory and cannot be trusted on its own. The matching private key is
//! never shipped; licenses are issued out-of-band with the `tools/licensegen`
//! CLI (see the README "Licensing" section).
//!
//! Enforcement is a *hard gate*: `lib.rs` only manages the SQLite `Db` state
//! when the license is [`LicenseStatus::Valid`], so every data command fails
//! without one, and the frontend shows a full-screen activation lock.

use base64::Engine;
use chrono::NaiveDate;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Ed25519 public key (32 raw bytes) matching the private key used to sign
/// licenses.
///
/// MUST be replaced with your own key from `licensegen keygen` before shipping.
/// The all-zero placeholder below is a valid curve point but no real license
/// will ever verify against it, so a build that forgets to swap it in simply
/// refuses every license (fails closed) rather than accepting forgeries.
const LICENSE_PUBLIC_KEY: [u8; 32] = [0u8; 32];

/// Filename of the certification file inside the app-data directory.
pub const LICENSE_FILENAME: &str = "license.psl";

/// `setting` key holding the latest date the app has ever observed. Used to
/// detect a system clock wound backwards to dodge expiry (anti-rollback).
pub const LAST_SEEN_KEY: &str = "license_last_seen";

/// Env var that, in a **debug build only**, skips the license gate so the app
/// opens without a signed license. Set to `1`/`true` during development
/// (e.g. `tauri dev`). Gated on `debug_assertions`, so release bundles ignore
/// it entirely — it can never be a production bypass.
pub const BYPASS_ENV: &str = "PAYMENT_SCHEDULE_LICENSE_BYPASS";

/// Whether the dev license bypass is active. True only when this is a debug
/// build **and** the override env var is truthy (`1`/`true`).
pub fn bypass_enabled() -> bool {
    bypass_decision(
        cfg!(debug_assertions),
        std::env::var(BYPASS_ENV).ok().as_deref(),
    )
}

/// Pure gate for the dev bypass, split from the compile-time flag and the
/// environment lookup so the policy can be unit-tested deterministically.
/// Uses `&&` (explicit opt-in) — unlike seeding's `||`, a debug build alone
/// does not skip the gate; the env var must be set too.
fn bypass_decision(debug_build: bool, bypass_env: Option<&str>) -> bool {
    debug_build && matches!(bypass_env, Some("1") | Some("true"))
}

/// Signed payload of a license. **Field order is part of the signing contract**
/// — the signature is computed over `serde_json::to_vec(&payload)`, so this
/// struct must stay byte-for-byte identical (names, order, types) to the one in
/// `tools/licensegen/src/main.rs`. Do not reorder or rename fields.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LicensePayload {
    pub license_id: String,
    pub licensee: String,
    pub machine_id_hash: String,
    pub issued_at: NaiveDate,
    pub expires_at: NaiveDate,
}

/// On-disk license document: the payload plus a base64 Ed25519 signature over
/// the payload's canonical JSON bytes.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct LicenseFile {
    payload: LicensePayload,
    signature: String,
}

/// Outcome of evaluating the license. `Valid` is the only status that unlocks
/// the app; every other value keeps it on the activation screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LicenseStatus {
    Valid,
    /// No license file present yet (fresh install).
    Missing,
    /// File unreadable / not valid JSON / signature not decodable.
    Malformed,
    /// Signature does not verify against the embedded public key (forged or
    /// tampered payload).
    BadSignature,
    /// Signature is genuine but issued for a different machine.
    WrongMachine,
    /// Genuine license whose validity window has not started yet.
    NotYetValid,
    /// Genuine license whose due date has passed.
    Expired,
    /// System clock is earlier than a date the app has already seen — a likely
    /// attempt to roll the clock back to escape expiry.
    ClockTampered,
}

impl LicenseStatus {
    pub fn is_valid(self) -> bool {
        matches!(self, LicenseStatus::Valid)
    }

    /// Whether the signature and machine binding checked out, regardless of the
    /// validity window. Such files are safe to persist on import (they are
    /// genuine, just possibly expired / not-yet-valid).
    pub fn is_authentic(self) -> bool {
        matches!(
            self,
            LicenseStatus::Valid | LicenseStatus::Expired | LicenseStatus::NotYetValid
        )
    }
}

/// Status returned to the frontend (camelCase JSON). Carries the machine
/// fingerprint (shown on the lock screen so the operator can request a license)
/// and, when the file is authentic, the licensee and dates.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseStatusDto {
    pub status: LicenseStatus,
    pub valid: bool,
    pub licensee: Option<String>,
    pub issued_at: Option<String>,
    pub expires_at: Option<String>,
    pub machine_id: String,
}

impl LicenseStatusDto {
    pub fn build(status: LicenseStatus, machine_id: &str, payload: Option<&LicensePayload>) -> Self {
        LicenseStatusDto {
            status,
            valid: status.is_valid(),
            licensee: payload.map(|p| p.licensee.clone()),
            issued_at: payload.map(|p| p.issued_at.to_string()),
            expires_at: payload.map(|p| p.expires_at.to_string()),
            machine_id: machine_id.to_string(),
        }
    }
}

/// Managed Tauri state holding the license status decided once at startup.
pub struct LicenseState {
    pub dto: LicenseStatusDto,
}

/// Stable fingerprint of the current machine: `sha256(domain || machine-uid)`
/// as lowercase hex. The raw OS machine id is never exposed — only this hash,
/// which is what a license binds to.
pub fn machine_fingerprint() -> String {
    let raw = machine_uid::get().unwrap_or_else(|_| "unknown-machine".to_string());
    let mut hasher = Sha256::new();
    hasher.update(b"paymentSchedule-license-v1:");
    hasher.update(raw.as_bytes());
    hex::encode(hasher.finalize())
}

/// Verify a license document against this machine and the clock, using the
/// public key embedded in the binary. See [`verify_with_key`] for the checks.
pub fn verify_license(
    contents: &str,
    machine_id: &str,
    today: NaiveDate,
    last_seen: Option<NaiveDate>,
) -> (LicenseStatus, Option<LicensePayload>) {
    let key = match VerifyingKey::from_bytes(&LICENSE_PUBLIC_KEY) {
        Ok(k) => k,
        // An unusable embedded key can never verify anything → fail closed.
        Err(_) => return (LicenseStatus::BadSignature, None),
    };
    verify_with_key(contents, &key, machine_id, today, last_seen)
}

/// Pure verification against an explicit public key. Returns the resulting
/// status and, when the file parses, its payload (so the caller can surface
/// licensee/dates even for an expired license). `last_seen` is the anti-rollback
/// watermark (the newest date the app has recorded); pass `None` to skip it.
///
/// Split from [`verify_license`] so the crypto + policy ordering can be unit
/// tested with a test keypair rather than the embedded production key.
fn verify_with_key(
    contents: &str,
    verifying_key: &VerifyingKey,
    machine_id: &str,
    today: NaiveDate,
    last_seen: Option<NaiveDate>,
) -> (LicenseStatus, Option<LicensePayload>) {
    let file: LicenseFile = match serde_json::from_str(contents) {
        Ok(f) => f,
        Err(_) => return (LicenseStatus::Malformed, None),
    };

    // Decode the signature (base64 -> 64 raw bytes).
    let sig_bytes = match base64::engine::general_purpose::STANDARD.decode(file.signature.trim()) {
        Ok(b) => b,
        Err(_) => return (LicenseStatus::Malformed, Some(file.payload)),
    };
    let sig_arr: [u8; 64] = match sig_bytes.as_slice().try_into() {
        Ok(a) => a,
        Err(_) => return (LicenseStatus::Malformed, Some(file.payload)),
    };
    let signature = Signature::from_bytes(&sig_arr);

    // Sign/verify over the canonical JSON of the payload (declared field order).
    let message = match serde_json::to_vec(&file.payload) {
        Ok(m) => m,
        Err(_) => return (LicenseStatus::Malformed, Some(file.payload)),
    };
    if verifying_key.verify_strict(&message, &signature).is_err() {
        return (LicenseStatus::BadSignature, Some(file.payload));
    }

    // Signature is genuine from here on.
    if file.payload.machine_id_hash != machine_id {
        return (LicenseStatus::WrongMachine, Some(file.payload));
    }
    if let Some(seen) = last_seen {
        if today < seen {
            return (LicenseStatus::ClockTampered, Some(file.payload));
        }
    }
    if today < file.payload.issued_at {
        return (LicenseStatus::NotYetValid, Some(file.payload));
    }
    if today > file.payload.expires_at {
        return (LicenseStatus::Expired, Some(file.payload));
    }
    (LicenseStatus::Valid, Some(file.payload))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;
    use ed25519_dalek::{Signer, SigningKey};

    const MACHINE: &str = "test-machine-fingerprint";

    fn day(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    /// Deterministic test signing key (never used in production).
    fn signing_key() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    /// Build a signed license file string with the given signing key + payload.
    fn make_license(signing: &SigningKey, payload: &LicensePayload) -> String {
        let message = serde_json::to_vec(payload).unwrap();
        let sig = signing.sign(&message);
        let file = LicenseFile {
            payload: payload.clone(),
            signature: STANDARD.encode(sig.to_bytes()),
        };
        serde_json::to_string(&file).unwrap()
    }

    fn sample_payload() -> LicensePayload {
        LicensePayload {
            license_id: "L-1".into(),
            licensee: "Test Shop".into(),
            machine_id_hash: MACHINE.into(),
            issued_at: day("2026-01-01"),
            expires_at: day("2027-01-01"),
        }
    }

    /// Verify a payload signed by our test key against that same key's public
    /// half — the production path uses the embedded key instead.
    fn verify(payload: &LicensePayload, today: &str, last_seen: Option<&str>) -> LicenseStatus {
        let signing = signing_key();
        let contents = make_license(&signing, payload);
        verify_with_key(
            &contents,
            &signing.verifying_key(),
            MACHINE,
            day(today),
            last_seen.map(day),
        )
        .0
    }

    #[test]
    fn machine_fingerprint_is_stable_hex() {
        let a = machine_fingerprint();
        let b = machine_fingerprint();
        assert_eq!(a, b, "fingerprint must be stable within a run");
        assert_eq!(a.len(), 64, "sha256 hex is 64 chars");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn valid_license_passes() {
        assert_eq!(verify(&sample_payload(), "2026-06-01", None), LicenseStatus::Valid);
    }

    #[test]
    fn boundaries_are_inclusive() {
        // Both the issue date and the due date are valid days.
        assert_eq!(verify(&sample_payload(), "2026-01-01", None), LicenseStatus::Valid);
        assert_eq!(verify(&sample_payload(), "2027-01-01", None), LicenseStatus::Valid);
    }

    #[test]
    fn expired_after_due_date() {
        assert_eq!(verify(&sample_payload(), "2027-01-02", None), LicenseStatus::Expired);
    }

    #[test]
    fn not_yet_valid_before_issue() {
        assert_eq!(verify(&sample_payload(), "2025-12-31", None), LicenseStatus::NotYetValid);
    }

    #[test]
    fn wrong_machine_rejected() {
        let mut p = sample_payload();
        p.machine_id_hash = "some-other-machine".into();
        assert_eq!(verify(&p, "2026-06-01", None), LicenseStatus::WrongMachine);
    }

    #[test]
    fn clock_rollback_detected() {
        // App last saw 2026-08-01; system clock now reads earlier -> tampered.
        assert_eq!(
            verify(&sample_payload(), "2026-06-01", Some("2026-08-01")),
            LicenseStatus::ClockTampered
        );
        // Clock at or past the watermark is fine.
        assert_eq!(
            verify(&sample_payload(), "2026-08-01", Some("2026-08-01")),
            LicenseStatus::Valid
        );
    }

    #[test]
    fn malformed_file_is_rejected() {
        let (status, payload) = verify_with_key(
            "not json",
            &signing_key().verifying_key(),
            MACHINE,
            day("2026-06-01"),
            None,
        );
        assert_eq!(status, LicenseStatus::Malformed);
        assert!(payload.is_none());
    }

    #[test]
    fn foreign_key_fails_signature() {
        // Signed by our test key, verified against a DIFFERENT key -> forged.
        let contents = make_license(&signing_key(), &sample_payload());
        let other = SigningKey::from_bytes(&[9u8; 32]).verifying_key();
        let (status, _) = verify_with_key(&contents, &other, MACHINE, day("2026-06-01"), None);
        assert_eq!(status, LicenseStatus::BadSignature);
    }

    #[test]
    fn tampered_payload_breaks_signature() {
        let signing = signing_key();
        let mut file: LicenseFile =
            serde_json::from_str(&make_license(&signing, &sample_payload())).unwrap();
        file.payload.expires_at = day("2099-01-01"); // extend expiry, keep old sig
        let contents = serde_json::to_string(&file).unwrap();
        let (status, _) =
            verify_with_key(&contents, &signing.verifying_key(), MACHINE, day("2026-06-01"), None);
        assert_eq!(status, LicenseStatus::BadSignature);
    }

    #[test]
    fn embedded_placeholder_key_fails_closed() {
        // The shipped placeholder key must never accept a real-looking license.
        let contents = make_license(&signing_key(), &sample_payload());
        let (status, _) = verify_license(&contents, MACHINE, day("2026-06-01"), None);
        assert_eq!(status, LicenseStatus::BadSignature);
    }

    #[test]
    fn bypass_off_in_release_regardless_of_env() {
        // In a release build (`debug_assertions` off) the env var is ignored,
        // so the gate can never be skipped on a delivered app.
        assert!(!bypass_decision(false, Some("1")));
        assert!(!bypass_decision(false, Some("true")));
        assert!(!bypass_decision(false, None));
    }

    #[test]
    fn bypass_requires_explicit_truthy_env_in_debug() {
        // Debug build: only an explicit truthy value opts in.
        assert!(bypass_decision(true, Some("1")));
        assert!(bypass_decision(true, Some("true")));
        assert!(!bypass_decision(true, None));
        assert!(!bypass_decision(true, Some("0")));
        assert!(!bypass_decision(true, Some("yes")));
    }

    /// Integration seam between `bypass_enabled()` and the real process
    /// environment: proves the public entry point reads the exact `BYPASS_ENV`
    /// name and composes it with the build flag (a typo in the env-var name
    /// would slip past the pure `bypass_decision` tests but fail here). The test
    /// binary is compiled with `debug_assertions`, so `cfg!` is `true` and the
    /// env var alone decides. Runs its mutations sequentially within this one
    /// body, and no other test touches `BYPASS_ENV`, so it is race-safe.
    #[test]
    fn bypass_enabled_reads_the_real_env_var() {
        let original = std::env::var(BYPASS_ENV).ok();

        std::env::set_var(BYPASS_ENV, "1");
        assert!(bypass_enabled(), "truthy env in a debug build enables the bypass");

        std::env::set_var(BYPASS_ENV, "0");
        assert!(!bypass_enabled(), "an explicit falsy value does not enable it");

        std::env::remove_var(BYPASS_ENV);
        assert!(!bypass_enabled(), "an unset env var leaves the gate enforced");

        // Restore whatever the surrounding environment had.
        match original {
            Some(v) => std::env::set_var(BYPASS_ENV, v),
            None => std::env::remove_var(BYPASS_ENV),
        }
    }

    #[test]
    fn status_predicates() {
        assert!(LicenseStatus::Valid.is_valid());
        assert!(!LicenseStatus::Expired.is_valid());
        assert!(LicenseStatus::Valid.is_authentic());
        assert!(LicenseStatus::Expired.is_authentic());
        assert!(LicenseStatus::NotYetValid.is_authentic());
        assert!(!LicenseStatus::WrongMachine.is_authentic());
        assert!(!LicenseStatus::BadSignature.is_authentic());
        assert!(!LicenseStatus::Missing.is_authentic());
        assert!(!LicenseStatus::ClockTampered.is_authentic());
    }

    #[test]
    fn dto_carries_payload_details() {
        let p = sample_payload();
        let dto = LicenseStatusDto::build(LicenseStatus::Expired, MACHINE, Some(&p));
        assert!(!dto.valid);
        assert_eq!(dto.licensee.as_deref(), Some("Test Shop"));
        assert_eq!(dto.expires_at.as_deref(), Some("2027-01-01"));
        assert_eq!(dto.machine_id, MACHINE);

        let empty = LicenseStatusDto::build(LicenseStatus::Missing, MACHINE, None);
        assert!(empty.licensee.is_none());
        assert!(empty.expires_at.is_none());
    }
}
