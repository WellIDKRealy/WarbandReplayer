#!/bin/bash
# Reproduces AdaWebPack's CI recipe (godunko/adawebpack .github/workflows/build.yml) to build
# GNAT-LLVM with a wasm32 target. Approved by the owner in the plan ("NEXT STRETCH" step 2).
set -ex
SP=${WR_TOOLS:-$HOME/wr-tools}   # working dir for sources/toolchains (outside the repo)
mkdir -p $SP/tools && cd $SP/tools
export PATH=$SP/tools/alr/bin:$PATH

[ -d adawebpack ] || git clone --depth 1 https://github.com/godunko/adawebpack.git adawebpack
[ -d gnat-llvm ] || {
  git clone -q https://github.com/AdaCore/gnat-llvm.git gnat-llvm
  git -C gnat-llvm checkout 66e36d929524972353600db5d604d0189cf0308f
}
LI=gnat-llvm/llvm-interface
[ -d $LI/bb-runtimes ] || git clone -q -b gnat-fsf-14 https://github.com/Fabien-Chouteau/bb-runtimes $LI/bb-runtimes
if [ ! -d $LI/gcc ]; then
  git clone -q --depth 1 --filter=blob:none --sparse --branch releases/gcc-14.1.0 \
      https://github.com/gcc-mirror/gcc $LI/gcc
  git -C $LI/gcc sparse-checkout set gcc/ada
fi
[ -d $LI/adawebpack_src ] || cp -r adawebpack $LI/adawebpack_src

LLVMDIR=$SP/tools/clang+llvm-16.0.4-x86_64-linux-gnu-ubuntu-22.04
if [ ! -d $LLVMDIR ]; then
  curl -sS -L -o llvm16.tar.xz \
    https://github.com/llvm/llvm-project/releases/download/llvmorg-16.0.4/clang+llvm-16.0.4-x86_64-linux-gnu-ubuntu-22.04.tar.xz
  tar xJf llvm16.tar.xz
fi

export PATH=$SP/tools/gnat-llvm/llvm-interface/bin:$PATH
export PATH=$(ls -d $HOME/.local/share/alire/toolchains/*/bin | tr '\n' ':')$PATH
export PATH=$LLVMDIR/bin:$PATH
cd $LI
[ -e .patched ] || {
  patch -p1 < adawebpack_src/patches/gnat-llvm.patch
  patch -p1 < adawebpack_src/patches/llvm_wrapper2.patch
  touch .patched
}
[ -e gnat_src ] || ln -sv gcc/gcc/ada gnat_src
[ -e Makefile.target ] || ln -sv adawebpack_src/source/rtl/Makefile.target
[ -e rts-sources ] || ln -sv bb-runtimes/gnat_rts_sources/include/rts-sources
make wasm -j2
echo BUILD_DONE
