fn main() {
    println!("cargo:rerun-if-env-changed=DDA_BUILD_RELEASE_CHANNEL");
    if let Ok(channel) = std::env::var("DDA_BUILD_RELEASE_CHANNEL") {
        assert!(
            matches!(
                channel.as_str(),
                "WINDOWS_MVP_PRE_PHASE1"
                    | "WINDOWS_PHASE1_READ_ONLY"
                    | "WINDOWS_PHASE1_5_CONTROLLED"
                    | "WINDOWS_FULL_LOCAL"
            ),
            "invalid build release channel"
        );
        println!("cargo:rustc-env=DDA_BAKED_RELEASE_CHANNEL={channel}");
    }
    tauri_build::build()
}
