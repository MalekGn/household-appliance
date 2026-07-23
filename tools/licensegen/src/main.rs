//! `licensegen` — offline issuer for paymentSchedule certification files.
//!
//! This tool holds the **private** signing key and is never distributed with
//! the app. Two subcommands:
//!
//! ```text
//! # 1. Once: create your keypair.
//! cargo run -- keygen [--out-dir .]
//!   -> private.key  (KEEP SECRET — the ability to mint licenses)
//!   -> public.key   (paste the printed array into src-tauri/src/license.rs)
//!
//! # 2. Per customer: issue a license bound to their machine + a due date.
//! cargo run -- issue \
//!     --machine-id <fingerprint from the app's lock screen> \
//!     --expires 2027-07-22 \
//!     [--issued 2026-07-22] [--licensee "Shop name"] [--id L-0001] \
//!     [--key private.key] [--out license.psl]
//!   -> license.psl  (send to the customer to import)
//! ```
//!
//! The signed payload struct below MUST stay byte-for-byte identical (field
//! names, order, types) to `LicensePayload` in `src-tauri/src/license.rs`, since
//! the signature is computed over `serde_json::to_vec(&payload)`.

use std::path::PathBuf;
use std::process::exit;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use chrono::NaiveDate;
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use rand_core::OsRng;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LicensePayload {
    license_id: String,
    licensee: String,
    machine_id_hash: String,
    issued_at: NaiveDate,
    expires_at: NaiveDate,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LicenseFile {
    payload: LicensePayload,
    signature: String,
}

fn main() {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("keygen") => keygen(args.collect()),
        Some("issue") => issue(args.collect()),
        Some("-h") | Some("--help") | None => usage(0),
        Some(other) => {
            eprintln!("Unknown command: {other}\n");
            usage(2);
        }
    }
}

fn usage(code: i32) -> ! {
    eprintln!(
        "licensegen — issue paymentSchedule certification files\n\n\
         USAGE:\n\
         \x20 licensegen keygen [--out-dir DIR]\n\
         \x20 licensegen issue --machine-id HASH --expires YYYY-MM-DD \\\n\
         \x20                   [--issued YYYY-MM-DD] [--licensee NAME] [--id ID] \\\n\
         \x20                   [--key private.key] [--out license.psl]\n"
    );
    exit(code);
}

/// Minimal `--flag value` parser. Returns the value for `name` if present.
fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
}

fn keygen(args: Vec<String>) {
    let out_dir = PathBuf::from(flag(&args, "--out-dir").unwrap_or_else(|| ".".to_string()));
    let signing = SigningKey::generate(&mut OsRng);
    let verifying: VerifyingKey = signing.verifying_key();

    let priv_path = out_dir.join("private.key");
    let pub_path = out_dir.join("public.key");

    // Private key: base64 of the 32-byte seed. Guard against clobbering.
    if priv_path.exists() {
        eprintln!(
            "Refusing to overwrite existing {} — move it aside first.",
            priv_path.display()
        );
        exit(1);
    }
    std::fs::write(&priv_path, STANDARD.encode(signing.to_bytes()))
        .unwrap_or_else(|e| fail(&format!("write {}: {e}", priv_path.display())));
    std::fs::write(&pub_path, STANDARD.encode(verifying.to_bytes()))
        .unwrap_or_else(|e| fail(&format!("write {}: {e}", pub_path.display())));

    // Print the array to paste into license.rs.
    let bytes = verifying.to_bytes();
    let rust_array = bytes
        .iter()
        .map(|b| b.to_string())
        .collect::<Vec<_>>()
        .join(", ");

    println!("Keypair written:");
    println!("  private key -> {}  (KEEP SECRET, never commit or ship)", priv_path.display());
    println!("  public  key -> {}", pub_path.display());
    println!("\nPaste this into src-tauri/src/license.rs (replace LICENSE_PUBLIC_KEY):\n");
    println!("const LICENSE_PUBLIC_KEY: [u8; 32] = [{rust_array}];");
}

fn issue(args: Vec<String>) {
    let machine_id = flag(&args, "--machine-id").unwrap_or_else(|| {
        eprintln!("--machine-id is required (the fingerprint shown on the app's lock screen).");
        exit(2);
    });
    let expires = parse_date_flag(&args, "--expires", None);
    let issued = parse_date_flag(&args, "--issued", Some(chrono::Local::now().date_naive()));
    if expires < issued {
        fail("--expires is before --issued");
    }
    let licensee = flag(&args, "--licensee").unwrap_or_default();
    let license_id = flag(&args, "--id").unwrap_or_else(|| format!("L-{}", issued.format("%Y%m%d")));
    let key_path = flag(&args, "--key").unwrap_or_else(|| "private.key".to_string());
    let out_path = flag(&args, "--out").unwrap_or_else(|| "license.psl".to_string());

    let signing = load_signing_key(&key_path);

    let payload = LicensePayload {
        license_id,
        licensee,
        machine_id_hash: machine_id,
        issued_at: issued,
        expires_at: expires,
    };

    // Sign the canonical JSON of the payload (compact, declared field order) —
    // this MUST match what the app re-serializes and verifies.
    let message = serde_json::to_vec(&payload).unwrap_or_else(|e| fail(&format!("serialize: {e}")));
    let signature = signing.sign(&message);

    let file = LicenseFile {
        payload,
        signature: STANDARD.encode(signature.to_bytes()),
    };
    let json = serde_json::to_string_pretty(&file).unwrap_or_else(|e| fail(&format!("encode: {e}")));
    std::fs::write(&out_path, json).unwrap_or_else(|e| fail(&format!("write {out_path}: {e}")));

    println!("Wrote {out_path}");
    println!("  machine : {}", file.payload.machine_id_hash);
    println!("  valid   : {} .. {}", file.payload.issued_at, file.payload.expires_at);
    println!("Send this file to the customer; they import it from the app's activation screen.");
}

fn parse_date_flag(args: &[String], name: &str, default: Option<NaiveDate>) -> NaiveDate {
    match flag(args, name) {
        Some(s) => NaiveDate::parse_from_str(&s, "%Y-%m-%d")
            .unwrap_or_else(|_| fail(&format!("{name} must be YYYY-MM-DD, got '{s}'"))),
        None => default.unwrap_or_else(|| {
            eprintln!("{name} is required (YYYY-MM-DD).");
            exit(2);
        }),
    }
}

fn load_signing_key(path: &str) -> SigningKey {
    let raw = std::fs::read_to_string(path)
        .unwrap_or_else(|e| fail(&format!("read key {path}: {e} (run `licensegen keygen` first)")));
    let bytes = STANDARD
        .decode(raw.trim())
        .unwrap_or_else(|e| fail(&format!("decode key {path}: {e}")));
    let arr: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .unwrap_or_else(|_| fail("private key must be 32 bytes"));
    SigningKey::from_bytes(&arr)
}

fn fail(msg: &str) -> ! {
    eprintln!("error: {msg}");
    exit(1);
}
