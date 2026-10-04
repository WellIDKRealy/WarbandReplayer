#!/bin/bash
# Source this file: puts gnatprove, GNAT and gprbuild (installed by Alire) on PATH.
#   . spark/tools/env.sh
GNATPROVE_BIN=$(ls -d /root/.local/share/alire/releases/gnatprove_*/bin 2>/dev/null | head -1)
GNAT_BIN=$(ls -d /root/.local/share/alire/toolchains/gnat_native_*/bin 2>/dev/null | head -1)
GPRBUILD_BIN=$(ls -d /root/.local/share/alire/toolchains/gprbuild_*/bin 2>/dev/null | head -1)
export PATH="$GNATPROVE_BIN:$GNAT_BIN:$GPRBUILD_BIN:$PATH"
