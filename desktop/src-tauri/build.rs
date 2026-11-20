fn main() {
    println!("cargo:rerun-if-env-changed=DDA_BUILD_RELEASE_CHANNEL");
    let channel = std::env::var("DDA_BUILD_RELEASE_CHANNEL")
        .unwrap_or_else(|_| "WINDOWS_PHASE1_5_CONTROLLED".to_string());
        assert!(
            matches!(
                channel.as_str(),
                "WINDOWS_PHASE1_5_CONTROLLED" | "WINDOWS_FULL_LOCAL"
            ),
            "invalid build release channel"
        );
        println!("cargo:rustc-env=DDA_BAKED_RELEASE_CHANNEL={channel}");
    tauri_build::build()
}
