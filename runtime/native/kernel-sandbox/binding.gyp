{
  "targets": [
    {
      "target_name": "dda_kernel_sandbox",
      "sources": [
        "src/bpf_builder.c",
        "src/napi_binding.c"
      ],
      "include_dirs": [ "src" ],
      "defines": [ "NAPI_VERSION=8" ],
      "cflags": [ "-Wall", "-Wextra", "-O2", "-fPIC" ],
      "cflags_c": [ "-std=c11" ],
      "conditions": [
        ["OS=='linux'", {
          "libraries!": [ "-lnode" ],
          "ldflags": [ "-Wl,-undefined,dynamic_lookup" ]
        }]
      ]
    }
  ]
}
