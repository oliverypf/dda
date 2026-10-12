#define NAPI_VERSION 8
#include <node_api.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "bpf_builder.h"

/* N-API Init ONLY registers exports (28th). No load-time enforce.
 * Host: emitStage1Filter() → raw sock_filter[] Buffer (never loads shim).
 * Worker: installFromHandoff() sync under --require shim (29th/30th).
 */

static napi_value EmitStage1Filter(napi_env env, napi_callback_info info) {
  (void)info;
  int size = dda_seccomp_filter_size(DDA_SECCOMP_STAGE1);
  if (size <= 0 || (size % 8) != 0) {
    napi_throw_error(env, NULL, "emitStage1Filter: invalid filter size");
    return NULL;
  }
  void *data = NULL;
  napi_value buffer;
  if (napi_create_buffer(env, (size_t)size, &data, &buffer) != napi_ok) {
    napi_throw_error(env, NULL, "emitStage1Filter: buffer alloc failed");
    return NULL;
  }
  int written = dda_seccomp_emit_filter(DDA_SECCOMP_STAGE1, (uint8_t *)data, (size_t)size);
  if (written != size) {
    napi_throw_error(env, NULL, "emitStage1Filter: emit failed");
    return NULL;
  }
  return buffer;
}

static napi_value EmitStage2Filter(napi_env env, napi_callback_info info) {
  (void)info;
  int size = dda_seccomp_filter_size(DDA_SECCOMP_STAGE2);
  if (size <= 0 || (size % 8) != 0) {
    napi_throw_error(env, NULL, "emitStage2Filter: invalid filter size");
    return NULL;
  }
  void *data = NULL;
  napi_value buffer;
  if (napi_create_buffer(env, (size_t)size, &data, &buffer) != napi_ok) {
    napi_throw_error(env, NULL, "emitStage2Filter: buffer alloc failed");
    return NULL;
  }
  int written = dda_seccomp_emit_filter(DDA_SECCOMP_STAGE2, (uint8_t *)data, (size_t)size);
  if (written != size) {
    napi_throw_error(env, NULL, "emitStage2Filter: emit failed");
    return NULL;
  }
  return buffer;
}

/* installFromHandoff: sync policy install. Reads DDA_KERNEL_SANDBOX_BACKEND from
 * env (bwrap|landlock). For bwrap: only stage-2 (NO_NEW_PRIVS+seccomp TSYNC);
 * Landlock rules are NOT installed on bwrap path (28th). For landlock: chdir to
 * private tmp then Landlock allow-list then stage-2. Landlock rules deferred to
 * C launcher path when ABI helpers land; here we still install stage-2 so cells
 * fail closed on exec/net even without Landlock FS rules in this MVP slice.
 */
static napi_value InstallFromHandoff(napi_env env, napi_callback_info info) {
  (void)info;
  const char *backend = getenv("DDA_KERNEL_SANDBOX_BACKEND");
  const char *private_tmp = getenv("DDA_KERNEL_SANDBOX_PRIVATE_TMP");

  if (backend && strcmp(backend, "landlock") == 0) {
    if (private_tmp && *private_tmp) {
      if (chdir(private_tmp) != 0) {
        napi_throw_error(env, NULL, "installFromHandoff: chdir private tmp failed");
        return NULL;
      }
    }
    /* Landlock ABI allow-list install belongs here when the full C launcher ships.
     * Until then detectKernelOsSandbox must NOT select backend=landlock (fail-closed).
     * This branch is only reached if a future complete Landlock path sets the env. */
  }

  int rc = dda_seccomp_install_stage2();
  if (rc != 0) {
    char msg[128];
    snprintf(msg, sizeof(msg), "installFromHandoff: stage-2 failed (%d)", rc);
    napi_throw_error(env, NULL, msg);
    return NULL;
  }

  napi_value result;
  napi_get_boolean(env, true, &result);
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn_emit1, fn_emit2, fn_install;
  napi_create_function(env, "emitStage1Filter", NAPI_AUTO_LENGTH, EmitStage1Filter, NULL, &fn_emit1);
  napi_create_function(env, "emitStage2Filter", NAPI_AUTO_LENGTH, EmitStage2Filter, NULL, &fn_emit2);
  napi_create_function(env, "installFromHandoff", NAPI_AUTO_LENGTH, InstallFromHandoff, NULL, &fn_install);
  napi_set_named_property(env, exports, "emitStage1Filter", fn_emit1);
  napi_set_named_property(env, exports, "emitStage2Filter", fn_emit2);
  napi_set_named_property(env, exports, "installFromHandoff", fn_install);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
