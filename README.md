
# Wasm Bare-Metal WebGL Cube
A minimal project demonstrating how to render a rotating 3D cube using WebGL and bare-metal WebAssembly (Wasm) written in C. 
This project bypasses heavy runtimes like Emscripten , establishing a direct pipeline between C memory, JavaScript, and the GPU. It uses the [`cglm`](https://github.com/recp/cglm) library for 3D math operations. 
[Click here to view the live demo](https://wellidkrealy.github.io/WebGL-Cube/)
## Project Structure
- [`index.html`](index.html): Initializes the WebGL context, streams and compiles the WebAssembly binary, exposes JS/WebGL hooks to C, and manages the animation render loop.
- [`main.c`](main.c): Contains the 3D cube vertex data, rotation/projection logic, and orchestrates the frame calculations.
- [`Makefile`](Makefile): Compiles the C source into a standalone WebAssembly module using standard LLVM tools (`clang` and `wasm-ld`).  
## Getting Started
### Prerequisites
You need the LLVM toolchain installed on your machine to compile the C code to WebAssembly:
- `clang`
- `wasm-ld`
### Compilation
To compile the C source files into `main.wasm`, run:
```bash
make
```
To clean up the compiled binary: 
```bash
make clean
```
### Running the Project
Because WebAssembly files cannot be loaded directly from the local file system (`file://`) due to browser CORS security policies, you must serve the files using a local HTTP server.
Run the following command in the project directory:
```bash
python3 -m http.server 8000
```
Once the server is running, open your browser and navigate to [`http://localhost:8000`](http://localhost:8000).
### How It Works
1. **Zero-Overhead Memory Sharing**: The vertex data array resides inside the Wasm linear memory space. JavaScript directly reads this memory layout via `exports.get_vertices()` and uploads it straight to the GPU VBO (Vertex Buffer Object) exactly once.
2. **Matrix Updates**: For every frame, the C code calculates a new Model-View-Projection ($MVP$) matrix based on elapsed time. It passes a pointer to this $4 \times 4$ float matrix back to JavaScript via `gl_update_matrix()`, which then pushes it to the WebGL uniform.
3. **Control Loop**: The JavaScript `requestAnimationFrame` loop continuously requests `exports.render_frame(time)`, keeping the C engine in control of the rendering.
