#define _GNU_SOURCE
#include "bpf_builder.h"

#include <errno.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef SECCOMP_RET_ALLOW
#define SECCOMP_RET_ALLOW 0x7fff0000U
#endif
#ifndef SECCOMP_RET_ERRNO
#define SECCOMP_RET_ERRNO 0x00050000U
#endif
#ifndef SECCOMP_RET_KILL_THREAD
#define SECCOMP_RET_KILL_THREAD 0x00000000U
#endif

#define SECCOMP_DATA_NR_OFFSET 0
#define SECCOMP_DATA_ARCH_OFFSET 4

/* x86_64 only for Phase-2b MVP (linux-x64). */
#if defined(__x86_64__)
#define DDA_AUDIT_ARCH AUDIT_ARCH_X86_64
#define DDA_NR_SOCKET 41
#define DDA_NR_CONNECT 42
#define DDA_NR_SOCKETPAIR 53
#define DDA_NR_EXECVE 59
#define DDA_NR_EXECVEAT 322
#define DDA_NR_IO_URING_SETUP 425
#define DDA_NR_IO_URING_ENTER 426
#define DDA_NR_IO_URING_REGISTER 427
#else
#error "dda kernel-sandbox BPF builder supports x86_64 only"
#endif

static int build(dda_seccomp_stage_t stage, struct sock_filter *out, size_t max_insns) {
  /* Program:
   * 0: LD arch
   * 1: JEQ AUDIT_ARCH_X86_64 else KILL (we only support this arch)
   * 2: LD nr
   * then JEQ each denied syscall → ERRNO(EPERM)
   * finally ALLOW
   */
  struct sock_filter prog[32];
  size_t n = 0;

  prog[n++] = (struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, SECCOMP_DATA_ARCH_OFFSET);
  prog[n++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, DDA_AUDIT_ARCH, 1, 0);
  /* wrong arch → KILL_THREAD (should never happen on our linux-x64 path) */
  prog[n++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_THREAD);
  prog[n++] = (struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, SECCOMP_DATA_NR_OFFSET);

  const int deny_stage1[] = {
    DDA_NR_SOCKET, DDA_NR_SOCKETPAIR, DDA_NR_CONNECT,
    DDA_NR_IO_URING_SETUP, DDA_NR_IO_URING_ENTER, DDA_NR_IO_URING_REGISTER
  };
  const int deny_exec[] = { DDA_NR_EXECVE, DDA_NR_EXECVEAT };

  int denials[16];
  size_t dcount = 0;
  for (size_t i = 0; i < sizeof(deny_stage1) / sizeof(deny_stage1[0]); i++) {
    denials[dcount++] = deny_stage1[i];
  }
  if (stage == DDA_SECCOMP_STAGE2) {
    for (size_t i = 0; i < sizeof(deny_exec) / sizeof(deny_exec[0]); i++) {
      denials[dcount++] = deny_exec[i];
    }
  }

  /* For each denial: JEQ nr → RET ERRNO; fall through otherwise.
   * jt jumps forward over the RET to the next compare / ALLOW.
   * Layout for each denial pair:
   *   JEQ nr, 0, 1   (if equal, fall to next insn = RET; else skip RET)
   *   RET ERRNO(EPERM)
   */
  for (size_t i = 0; i < dcount; i++) {
    prog[n++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (unsigned)denials[i], 0, 1);
    prog[n++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & 0xffff));
  }
  prog[n++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);

  if (n > max_insns) return -1;
  if (out) memcpy(out, prog, n * sizeof(struct sock_filter));
  return (int)n;
}

int dda_seccomp_filter_size(dda_seccomp_stage_t stage) {
  int n = build(stage, NULL, 64);
  if (n < 0) return -1;
  return n * (int)sizeof(struct sock_filter);
}

int dda_seccomp_emit_filter(dda_seccomp_stage_t stage, uint8_t *out, size_t out_cap) {
  struct sock_filter tmp[64];
  int n = build(stage, tmp, 64);
  if (n < 0) return -1;
  size_t bytes = (size_t)n * sizeof(struct sock_filter);
  if (bytes > out_cap || out == NULL) return -1;
  memcpy(out, tmp, bytes);
  return (int)bytes;
}

static int install_filter(dda_seccomp_stage_t stage, int with_nnp) {
  struct sock_filter tmp[64];
  int n = build(stage, tmp, 64);
  if (n < 0) return -EINVAL;
  struct sock_fprog prog = {
    .len = (unsigned short)n,
    .filter = tmp
  };
  if (with_nnp) {
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return -errno;
  }
  /* Prefer seccomp(2) with TSYNC; fall back to prctl without TSYNC only if syscall missing. */
  long rc = syscall(__NR_seccomp, SECCOMP_SET_MODE_FILTER, SECCOMP_FILTER_FLAG_TSYNC, &prog);
  if (rc == 0) return 0;
  if (errno == ENOSYS) {
    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog) != 0) return -errno;
    return 0;
  }
  return -errno;
}

int dda_seccomp_install_stage1(void) {
  return install_filter(DDA_SECCOMP_STAGE1, 0);
}

int dda_seccomp_install_stage2(void) {
  /* Order locked (14th): NO_NEW_PRIVS then seccomp(+TSYNC). Stage-2 merges
   * stage-1 denials + execve/execveat so it may replace/stack as a combined filter. */
  return install_filter(DDA_SECCOMP_STAGE2, 1);
}
