call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\Common7\Tools\VsDevCmd.bat" -arch=x64 -host_arch=x64
set RUSTUP_TOOLCHAIN=1.97.0-x86_64-pc-windows-msvc
set CARGO_BUILD_TARGET=x86_64-pc-windows-msvc
npm run build:windows
