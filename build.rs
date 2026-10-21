extern crate napi_build;

fn main() {
    napi_build::setup();

    // The npm package version is the single source of truth for the version
    // reported by the native `version()` function.
    //
    // `scripts/build-native.mjs` passes the package.json version in as
    // HYPERGLOB_VERSION. A plain `cargo build` (no env var) falls back to the
    // crate version, which Cargo.toml keeps in sync with package.json.
    //
    // CARGO_PKG_VERSION is available to build scripts as an environment
    // variable, so the fallback needs no manifest parsing.
    let version = std::env::var("HYPERGLOB_VERSION")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| std::env::var("CARGO_PKG_VERSION").ok())
        .unwrap_or_else(|| "0.0.0-unknown".to_string());

    println!("cargo:rustc-env=HYPERGLOB_VERSION={version}");
    println!("cargo:rerun-if-env-changed=HYPERGLOB_VERSION");
}
