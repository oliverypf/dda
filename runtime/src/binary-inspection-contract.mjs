export const MAX_PE_HEADER_OFFSET = 1024 * 1024;
export const MAX_PE_HEADER_READ_BYTES = 64 + 24 + 112;

export const BINARY_INSPECTION_DESCRIPTION = 'Inspect a Windows PE executable or DLL using bounded read-only header reads. Use this tool, not shell.execute or node -e, to check file size, MZ/PE signatures, CPU architecture, DLL flag and subsystem of a build artifact. Supply only the artifact path. No file is executed or modified. Reports header metadata only, not loadability, authenticity, functionality, or build success. It does not return file contents or a whole-file digest.';

export const BINARY_INSPECTION_GUIDANCE = 'For Windows executable or DLL header checks, prefer workspace.inspect_binary with the artifact path rather than an inline interpreter. Use the workspace build output path; protected application and runtime directories remain forbidden even with FULL_ACCESS. A successful header inspection alone does not prove a build or task succeeded. Arbitrary inline scripts still require the existing safety checks; do not evade a denial by materializing the same script in a file or changing interpreters.';
