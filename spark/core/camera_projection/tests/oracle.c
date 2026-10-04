/* Differential oracle for camera_projection: the OLD engine's main.c, included UNMODIFIED.
 *
 * Build (run_tests.sh):  clang -O1 -ffp-contract=off -I<repo> -I<repo>/cglm/include -c oracle.c
 *
 * main.c is a freestanding wasm translation unit whose only imports are the gl_* / js_log_string
 * functions of main.js; they are stubbed here (no-ops) so that the REAL set_screen_dimensions,
 * set_map_bounds, apply_zoom, pan_camera, set_view_shift, set_key_state and render_frame (key panning,
 * aspect, x_bound) run natively with the same 32-bit float arithmetic as the wasm build.  The o_* wrappers
 * below only drive and read the globals of main.c; they contain no camera logic of their own.
 */
#include <stdint.h>
#include <string.h>
#include <math.h>

#include "main.c"

/* ---- stubs for the imports declared `extern` at the top of main.c ---------------------------- */
void gl_clear_color(float r, float g, float b, float a) { (void)r; (void)g; (void)b; (void)a; }
void gl_clear(int mask) { (void)mask; }
int  gl_create_shader(int type) { (void)type; return 0; }
void gl_shader_source(int shader, const char* src) { (void)shader; (void)src; }
void gl_compile_shader(int shader) { (void)shader; }
int  gl_create_program(void) { return 0; }
void gl_attach_shader(int program, int shader) { (void)program; (void)shader; }
void gl_link_program(int program) { (void)program; }
void gl_use_program(int program) { (void)program; }
int  gl_get_uniform_location(int program, const char* name) { (void)program; (void)name; return 0; }
int  gl_get_attrib_location(int program, const char* name) { (void)program; (void)name; return 0; }
int  gl_create_buffer(void) { return 0; }
void gl_bind_buffer(int target, int buffer) { (void)target; (void)buffer; }
void gl_buffer_data(int target, const float* data, int num_bytes, int usage) { (void)target; (void)data; (void)num_bytes; (void)usage; }
void gl_enable_vertex_attrib_array(int index) { (void)index; }
void gl_vertex_attrib_pointer(int index, int size, int type, int normalized, int stride, int offset) { (void)index; (void)size; (void)type; (void)normalized; (void)stride; (void)offset; }
void gl_uniform1f(int location, float x) { (void)location; (void)x; }
void gl_uniform2f(int location, float x, float y) { (void)location; (void)x; (void)y; }
void gl_uniform3f(int location, float r, float g, float b) { (void)location; (void)r; (void)g; (void)b; }
void gl_uniform_matrix4fv(int location, const float* matrix_ptr) { (void)location; (void)matrix_ptr; }
void gl_draw_arrays(int mode, int first, int count) { (void)mode; (void)first; (void)count; }
void gl_viewport(int x, int y, int w, int h) { (void)x; (void)y; (void)w; (void)h; }
void js_log_string(const char* msg) { (void)msg; }

/* ---- driver ----------------------------------------------------------------------------------- */
/* Every camera-related global of main.c, as raw 32-bit patterns (so NaN / -0 compare exactly). */
typedef struct {
    uint32_t cam_x, cam_y, zoom, shift_x, shift_y;
    int32_t  width, height;
    uint32_t min_x, max_x, min_y, max_y;
    int32_t  keys[4];
} OState;

static uint32_t bits(float f) { uint32_t u; memcpy(&u, &f, 4); return u; }
static float    flt(uint32_t u) { float f; memcpy(&f, &u, 4); return f; }

void o_get(OState *s) {
    s->cam_x = bits(cam_x); s->cam_y = bits(cam_y); s->zoom = bits(cam_zoom);
    s->shift_x = bits(view_shift_x); s->shift_y = bits(view_shift_y);
    s->width = screen_width; s->height = screen_height;
    s->min_x = bits(map_min_x); s->max_x = bits(map_max_x);
    s->min_y = bits(map_min_y); s->max_y = bits(map_max_y);
    for (int i = 0; i < 4; i++) s->keys[i] = keys[i];
}

void o_set(const OState *s) {
    cam_x = flt(s->cam_x); cam_y = flt(s->cam_y); cam_zoom = flt(s->zoom);
    view_shift_x = flt(s->shift_x); view_shift_y = flt(s->shift_y);
    screen_width = s->width; screen_height = s->height;
    map_min_x = flt(s->min_x); map_max_x = flt(s->max_x);
    map_min_y = flt(s->min_y); map_max_y = flt(s->max_y);
    for (int i = 0; i < 4; i++) keys[i] = s->keys[i];
}

/* The initialisers of main.c lines 62-73. */
void o_reset(void) {
    cam_x = 0.0f; cam_y = 0.0f; cam_zoom = 1.0f;
    screen_width = 800; screen_height = 600;
    keys[0] = keys[1] = keys[2] = keys[3] = 0;
    view_shift_x = 0.0f; view_shift_y = 0.0f;
    map_min_x = -100.0f; map_max_x = 100.0f; map_min_y = -100.0f; map_max_y = 100.0f;
}

void o_set_screen(int w, int h)                                  { set_screen_dimensions(w, h); }
void o_set_map_bounds(float a, float b, float c, float d)        { set_map_bounds(a, b, c, d); }
void o_apply_zoom(float dy)                                      { apply_zoom(dy); }
void o_pan(float dx, float dy)                                   { pan_camera(dx, dy); }
void o_set_view_shift(float x, float y)                          { set_view_shift(x, y); }
void o_set_key(int idx, int pressed)                             { set_key_state(idx, pressed); }
void o_render_frame(float dt)                                    { render_frame(dt); }

/* Independent classifier for the tests: C's own isfinite on a raw pattern. */
int o_isfinite32(uint32_t u) { return isfinite(flt(u)) ? 1 : 0; }
int o_isfinite64(uint64_t u) { double d; memcpy(&d, &u, 8); return isfinite(d) ? 1 : 0; }
