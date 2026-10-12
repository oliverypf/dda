#ifndef DDA_KERNEL_SANDBOX_BPF_BUILDER_H
#define DDA_KERNEL_SANDBOX_BPF_BUILDER_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Stage-1: deny socket/socketpair/connect + io_uring_*; ALLOW everything else.
 * Stage-2: stage-1 denials PLUS execve/execveat.
 * Both filters: default SCMP_ACT_ALLOW; deny = SECCOMP_RET_ERRNO(EPERM).
 * Output is classic BPF sock_filter[] raw bytes (len % 8 == 0) for bwrap --seccomp.
 */

typedef enum {
  DDA_SECCOMP_STAGE1 = 1,
  DDA_SECCOMP_STAGE2 = 2
} dda_seccomp_stage_t;

/* Returns number of bytes written into out, or -1 on error / short buffer.
 * out_cap is capacity in bytes. Required size is available via dda_seccomp_filter_size().
 */
int dda_seccomp_filter_size(dda_seccomp_stage_t stage);
int dda_seccomp_emit_filter(dda_seccomp_stage_t stage, uint8_t *out, size_t out_cap);

/* Install the filter in the current process with NO_NEW_PRIVS first (stage-2 path).
 * Uses SECCOMP_FILTER_FLAG_TSYNC. Returns 0 on success, -errno on failure.
 */
int dda_seccomp_install_stage2(void);

/* Install stage-1 only (Landlock launcher / early path). Returns 0 / -errno. */
int dda_seccomp_install_stage1(void);

#ifdef __cplusplus
}
#endif

#endif
