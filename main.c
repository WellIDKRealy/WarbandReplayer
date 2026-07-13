#include <math.h>
#include <cglm/cglm.h>

// WebGL Constants
#define GL_FRAGMENT_SHADER            0x8B30
#define GL_VERTEX_SHADER              0x8B31
#define GL_ARRAY_BUFFER               0x8892
#define GL_STATIC_DRAW                0x88E4
#define GL_COLOR_BUFFER_BIT           0x00004000
#define GL_FLOAT                      0x1406
#define GL_TRIANGLES                  0x0004
#define GL_TRIANGLE_FAN               0x0006
#define GL_LINE_LOOP                  0x0002

// Binding Functions from Javascript VM
extern void gl_clear_color(float r, float g, float b, float a);
extern void gl_clear(int mask);
extern int  gl_create_shader(int type);
extern void gl_shader_source(int shader, const char* src);
extern void gl_compile_shader(int shader);
extern int  gl_create_program();
extern void gl_attach_shader(int program, int shader);
extern void gl_link_program(int program);
extern void gl_use_program(int program);
extern int  gl_get_uniform_location(int program, const char* name);
extern int  gl_get_attrib_location(int program, const char* name);
extern int  gl_create_buffer();
extern void gl_bind_buffer(int target, int buffer);
extern void gl_buffer_data(int target, const float* data, int num_bytes, int usage);
extern void gl_enable_vertex_attrib_array(int index);
extern void gl_vertex_attrib_pointer(int index, int size, int type, int normalized, int stride, int offset);
extern void gl_uniform1f(int location, float x);
extern void gl_uniform2f(int location, float x, float y);
extern void gl_uniform3f(int location, float r, float g, float b);
extern void gl_uniform_matrix4fv(int location, const float* matrix_ptr);
extern void gl_draw_arrays(int mode, int first, int count);
extern void gl_viewport(int x, int y, int w, int h);
extern void js_log_string(const char* msg);

#define MAX_AGENTS 1000
#define BALL_RADIUS 0.75f
#define CIRCLE_SEGS 18

float circle_vertices[(CIRCLE_SEGS + 2) * 3];
float map_bounds_vertices[4 * 3];

// Local shader storage allocations
char vs_main_src[8192]; char fs_main_src[8192];
char vs_grid_src[8192]; char fs_grid_src[32768];

char* get_vs_main_ptr() { return vs_main_src; }
char* get_fs_main_ptr() { return fs_main_src; }
char* get_vs_grid_ptr() { return vs_grid_src; }
char* get_fs_grid_ptr() { return fs_grid_src; }

int program_main, program_grid;
int loc_mvp, loc_uColor, attr_position_main;
int loc_grid_camOffset, loc_grid_zoom, loc_grid_resolution, attr_position_grid;
int vbo_circle, vbo_box, vbo_quad;

// Engine Viewport Vectors
float cam_x = 0.0f, cam_y = 0.0f, cam_zoom = 1.0f;
int screen_width = 800, screen_height = 600;
int keys[4] = {0, 0, 0, 0};

float map_min_x = -100.0f, map_max_x = 100.0f;
float map_min_y = -100.0f, map_max_y = 100.0f;

// Shared Wasm Memory: Array layout [x, y, team, x, y, team...]
float agent_buffer[MAX_AGENTS * 3];
int active_agent_count = 0;

float* get_agent_buffer_ptr() { return agent_buffer; }
void update_frame_data(int count) { active_agent_count = count; }

void set_map_bounds(float min_x, float max_x, float min_y, float max_y) {
    map_min_x = min_x; map_max_x = max_x;
    map_min_y = min_y; map_max_y = max_y;
    
    // Auto-center view inside new map boundaries
    cam_x = (min_x + max_x) / 2.0f;
    cam_y = (min_y + max_y) / 2.0f;
    
    // Calculate custom zoom step to frame the boundaries nicely
    float span_x = fabsf(max_x - min_x);
    float span_y = fabsf(max_y - min_y);
    float max_span = (span_x > span_y) ? span_x : span_y;
    if (max_span > 0.0f) {
        cam_zoom = 20.0f / max_span;
        if (cam_zoom < 0.05f) cam_zoom = 0.05f;
        if (cam_zoom > 10.0f) cam_zoom = 10.0f;
    }

    // Build line-loop vertices defining the map boundary rectangle
    float box[] = { 
        min_x, min_y, 0.0f,  
        max_x, min_y, 0.0f,  
        max_x, max_y, 0.0f,  
        min_x, max_y, 0.0f 
    };
    for(int i = 0; i < 12; i++) map_bounds_vertices[i] = box[i];
    
    gl_bind_buffer(GL_ARRAY_BUFFER, vbo_box);
    gl_buffer_data(GL_ARRAY_BUFFER, map_bounds_vertices, sizeof(map_bounds_vertices), GL_STATIC_DRAW);
    
    js_log_string("[Renderer] Coordinate bounding limits loaded.");
}

void set_screen_dimensions(int w, int h) { screen_width = w; screen_height = h; }
void set_key_state(int key_idx, int is_pressed) { if (key_idx >= 0 && key_idx < 4) keys[key_idx] = is_pressed; }

void apply_zoom(float delta_y) {
    if (delta_y > 0) cam_zoom *= 0.90f;
    else if (delta_y < 0) cam_zoom *= 1.10f;
    if (cam_zoom < 0.02f) cam_zoom = 0.02f;
    if (cam_zoom > 40.0f) cam_zoom = 40.0f;
}

int compile_shader_program(const char* vs_src, const char* fs_src) {
    int vs = gl_create_shader(GL_VERTEX_SHADER);
    gl_shader_source(vs, vs_src); gl_compile_shader(vs);
    int fs = gl_create_shader(GL_FRAGMENT_SHADER);
    gl_shader_source(fs, fs_src); gl_compile_shader(fs);
    int prog = gl_create_program();
    gl_attach_shader(prog, vs); gl_attach_shader(prog, fs);
    gl_link_program(prog);
    return prog;
}

void init_engine() {
    circle_vertices[0] = 0.0f; circle_vertices[1] = 0.0f; circle_vertices[2] = 0.0f;
    for (int i = 0; i <= CIRCLE_SEGS; i++) {
        float angle = 2.0f * 3.14159265f * ((float)i / CIRCLE_SEGS);
        int idx = (i + 1) * 3;
        circle_vertices[idx + 0] = cosf(angle);
        circle_vertices[idx + 1] = sinf(angle);
        circle_vertices[idx + 2] = 0.0f;
    }
}

void init_gl_programs() {
    program_main = compile_shader_program(vs_main_src, fs_main_src);
    loc_mvp = gl_get_uniform_location(program_main, "mvp");
    loc_uColor = gl_get_uniform_location(program_main, "uColor");
    attr_position_main = gl_get_attrib_location(program_main, "position");

    program_grid = compile_shader_program(vs_grid_src, fs_grid_src);
    loc_grid_camOffset = gl_get_uniform_location(program_grid, "u_camOffset");
    loc_grid_zoom = gl_get_uniform_location(program_grid, "u_zoom");
    loc_grid_resolution = gl_get_uniform_location(program_grid, "u_resolution");
    attr_position_grid = gl_get_attrib_location(program_grid, "position");

    vbo_circle = gl_create_buffer();
    gl_bind_buffer(GL_ARRAY_BUFFER, vbo_circle);
    gl_buffer_data(GL_ARRAY_BUFFER, circle_vertices, sizeof(circle_vertices), GL_STATIC_DRAW);

    vbo_box = gl_create_buffer();

    float quad_vertices[] = { -1.0f, -1.0f,  1.0f, -1.0f, -1.0f,  1.0f, -1.0f,  1.0f,  1.0f, -1.0f,  1.0f,  1.0f };
    vbo_quad = gl_create_buffer();
    gl_bind_buffer(GL_ARRAY_BUFFER, vbo_quad);
    gl_buffer_data(GL_ARRAY_BUFFER, quad_vertices, sizeof(quad_vertices), GL_STATIC_DRAW);

    gl_clear_color(0.08f, 0.08f, 0.08f, 1.0f);
}

void render_frame(float dt_seconds) {
    float pan_speed = 35.0f / cam_zoom;
    if (keys[0]) cam_y += pan_speed * dt_seconds; // W
    if (keys[2]) cam_y -= pan_speed * dt_seconds; // S
    if (keys[1]) cam_x -= pan_speed * dt_seconds; // A
    if (keys[3]) cam_x += pan_speed * dt_seconds; // D

    float aspect = (float)screen_width / (float)screen_height;
    float x_bound = 30.0f; float y_bound = 30.0f;
    if (aspect > 1.0f) { x_bound *= aspect; } else { y_bound /= aspect; }

    mat4 projection;
    glm_ortho(-x_bound, x_bound, -y_bound, y_bound, -1.0f, 1.0f, projection);

    mat4 view = GLM_MAT4_IDENTITY_INIT;
    glm_scale_uni(view, cam_zoom);
    vec3 translate_vec = {-cam_x, -cam_y, 0.0f};
    glm_translate(view, translate_vec);

    mat4 vp;
    glm_mat4_mul(projection, view, vp);

    gl_clear(GL_COLOR_BUFFER_BIT);

    // 1. Render Shader-based coordinate grid background
    gl_use_program(program_grid);
    gl_uniform2f(loc_grid_camOffset, cam_x, cam_y);
    gl_uniform1f(loc_grid_zoom, cam_zoom);
    gl_uniform2f(loc_grid_resolution, (float)screen_width, (float)screen_height);
    gl_bind_buffer(GL_ARRAY_BUFFER, vbo_quad);
    gl_vertex_attrib_pointer(attr_position_grid, 2, GL_FLOAT, 0, 0, 0);
    gl_enable_vertex_attrib_array(attr_position_grid);
    gl_draw_arrays(GL_TRIANGLES, 0, 6);

    // 2. Render Map Rectangle limits using main shader program
    gl_use_program(program_main);
    gl_enable_vertex_attrib_array(attr_position_main);

    // Map limits box color: White
    gl_uniform3f(loc_uColor, 1.0f, 1.0f, 1.0f);
    gl_uniform_matrix4fv(loc_mvp, (float*)vp);
    gl_bind_buffer(GL_ARRAY_BUFFER, vbo_box);
    gl_vertex_attrib_pointer(attr_position_main, 3, GL_FLOAT, 0, 12, 0);
    gl_draw_arrays(GL_LINE_LOOP, 0, 4);

    // 3. Render Human Players as Circle Fans
    gl_bind_buffer(GL_ARRAY_BUFFER, vbo_circle);
    gl_vertex_attrib_pointer(attr_position_main, 3, GL_FLOAT, 0, 12, 0);

    for (int i = 0; i < active_agent_count; i++) {
        float ax = agent_buffer[i * 3 + 0];
        float ay = agent_buffer[i * 3 + 1];
        float team = agent_buffer[i * 3 + 2];

        mat4 model = GLM_MAT4_IDENTITY_INIT;
        vec3 translate = {ax, ay, 0.0f};
        glm_translate(model, translate);
        glm_scale_uni(model, BALL_RADIUS);

        mat4 mvp;
        glm_mat4_mul(vp, model, mvp);
        gl_uniform_matrix4fv(loc_mvp, (float*)mvp);

        // Assign colors based on Team: Team 0 (Red), Team 1 (Blue), Spectators/Unassigned (Gray)
        if (team == 0.0f) {
            gl_uniform3f(loc_uColor, 0.95f, 0.25f, 0.25f);
        } else if (team == 1.0f) {
            gl_uniform3f(loc_uColor, 0.25f, 0.45f, 0.95f);
        } else {
            gl_uniform3f(loc_uColor, 0.6f, 0.6f, 0.6f);
        }

        gl_draw_arrays(GL_TRIANGLE_FAN, 0, CIRCLE_SEGS + 2);
    }
}
