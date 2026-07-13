#include <math.h>
#include <cglm/cglm.h>

// WebGL Enums Mapping Configurations
#define GL_FRAGMENT_SHADER            0x8B30
#define GL_VERTEX_SHADER              0x8B31
#define GL_ARRAY_BUFFER               0x8892
#define GL_STATIC_DRAW                0x88E4
#define GL_COLOR_BUFFER_BIT           0x00004000
#define GL_FLOAT                      0x1406
#define GL_TRIANGLES                  0x0004
#define GL_TRIANGLE_FAN               0x0006
#define GL_LINE_LOOP                  0x0002

// External low-level WebGL Core Bindings linked from JavaScript context environment
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

#define NUM_BALLS 60
#define BOUNDS 12.0f
#define BALL_RADIUS 0.5f
#define CIRCLE_SEGS 16

float circle_vertices[(CIRCLE_SEGS + 2) * 3];
float box_vertices[4 * 3];

// Static allocations hosting incoming raw text representations parsed out of shaders.glsl
char vs_main_src[8192];
char fs_main_src[8192];
char vs_grid_src[8192];
char fs_grid_src[32768];

char* get_vs_main_ptr() { return vs_main_src; }
char* get_fs_main_ptr() { return fs_main_src; }
char* get_vs_grid_ptr() { return vs_grid_src; }
char* get_fs_grid_ptr() { return fs_grid_src; }

// Compiled program identifiers and state uniform targets
int program_main;
int program_grid;

int loc_mvp;
int loc_uColor;
int attr_position_main;

int loc_grid_camOffset;
int loc_grid_zoom;
int loc_grid_resolution;
int attr_position

typedef struct {
    vec2 pos;
    vec2 vel;
    vec3 color;
} Ball;

Ball balls[NUM_BALLS];

float cam_x = 0.0f;
float cam_y = 0.0f;
float cam_zoom = 1.0f;
int screen_width = 800;
int screen_height = 600;
int keys[4] = {0, 0, 0, 0};
int active_ball_count = 0;

char file_input_buffer[65536]; 
int uploaded_file_bytes = 0;
int ongoing_loading_step = 0;
int targeted_loading_steps = 180;

char* get_file_buffer_ptr() { return file_input_buffer; }
int get_file_buffer_max_size() { return sizeof(file_input_buffer); }

float parse_float(const char* str, int* cursor) {
    int i = *cursor;
    while (str[i] == ' ' || str[i] == ',' || str[i] == '\n' || str[i] == '\r' || str[i] == '\t') {
        if (str[i] == '\0') { *cursor = i; return 0.0f; }
        i++;
    }
    if (str[i] == '\0') { *cursor = i; return 0.0f; }

    float sign = 1.0f;
    if (str[i] == '-') { sign = -1.0f; i++; }
    else if (str[i] == '+') { i++; }

    float value = 0.0f;
    while (str[i] >= '0' && str[i] <= '9') {
        value = value * 10.0f + (str[i] - '0');
        i++;
    }
    if (str[i] == '.') {
        i++;
        float division_factor = 10.0f;
        while (str[i] >= '0' && str[i] <= '9') {
            value += (str[i] - '0') / division_factor;
            division_factor *= 10.0f;
            i++;
        }
    }
    *cursor = i;
    return value * sign;
}

void prepare_simulation_loading(int parsed_bytes) {
    uploaded_file_bytes = parsed_bytes;
    ongoing_loading_step = 0;
    js_log_string("[System] Text configuration streamed into C memory.");

    if (uploaded_file_bytes < sizeof(file_input_buffer)) {
        file_input_buffer[uploaded_file_bytes] = '\0';
    } else {
        file_input_buffer[sizeof(file_input_buffer) - 1] = '\0';
    }

    int cursor_index = 0;
    active_ball_count = 0;

    while (active_ball_count < NUM_BALLS) {
        while (file_input_buffer[cursor_index] == ' ' || file_input_buffer[cursor_index] == ',' || 
               file_input_buffer[cursor_index] == '\n' || file_input_buffer[cursor_index] == '\r' || 
               file_input_buffer[cursor_index] == '\t') {
            cursor_index++;
        }
        if (file_input_buffer[cursor_index] == '\0') break;

        int start_pos = cursor_index;
        balls[active_ball_count].pos[0] = parse_float(file_input_buffer, &cursor_index);
        balls[active_ball_count].pos[1] = parse_float(file_input_buffer, &cursor_index);
        
        if (cursor_index == start_pos) break;

        int i = active_ball_count;
        balls[i].vel[0] = (i % 2 == 0 ? 5.0f : -5.0f) * (1.0f + (float)(i % 3) * 0.2f);
        balls[i].vel[1] = (i % 3 == 0 ? -4.0f : 4.0f) * (1.0f + (float)(i % 2) * 0.3f);
        balls[i].color[0] = 0.4f + (float)(i % 4) * 0.15f;
        balls[i].color[1] = 0.5f + (float)(i % 3) * 0.15f;
        balls[i].color[2] = 0.7f + (float)(i % 2) * 0.15f;

        active_ball_count++;
    }
}

float execute_loading_step() {
    if (ongoing_loading_step < targeted_loading_steps) {
        ongoing_loading_step++;
        volatile int compute_burn = 0;
        for (int i = 0; i < 7500000; i++) {
            compute_burn += i * 5;
        }
        if (ongoing_loading_step % 35 == 0) {
            js_log_string("[Engine] Matrix precomputations processing step...");
        }
    }
    return ((float)ongoing_loading_step / (float)targeted_loading_steps) * 100.0f;
}

void set_screen_dimensions(int w, int h) { screen_width = w; screen_height = h; }
void set_key_state(int key_idx, int is_pressed) { if (key_idx >= 0 && key_idx < 4) keys[key_idx] = is_pressed; }

void apply_zoom(float delta_y) {
    if (delta_y > 0) cam_zoom *= 0.88f;
    else if (delta_y < 0) cam_zoom *= 1.12f;
    if (cam_zoom < 0.1f) cam_zoom = 0.1f;
    if (cam_zoom > 25.0f) cam_zoom = 25.0f;
}

// Fixed compilation pipeline for Bare-Metal driven program linkings
int compile_shader_program(const char* vs_src, const char* fs_src) {
    int vs = gl_create_shader(GL_VERTEX_SHADER);
    gl_shader_source(vs, vs_src);
    gl_compile_shader(vs);

    int fs = gl_create_shader(GL_FRAGMENT_SHADER);
    gl_shader_source(fs, fs_src);
    gl_compile_shader(fs);

    int prog = gl_create_program();
    gl_attach_shader(prog, vs);
    gl_attach_shader(prog, fs);
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
    float b = BOUNDS;
    float box[] = { -b,-b,0.f, b,-b,0.f, b,b,0.f, -b,b,0.f };
    for(int i = 0; i < 12; i++) box_vertices[i] = box[i];
}

void init_gl_programs() {
    // Compile and set up main drawing program bindings
    program_main = compile_shader_program(vs_main_src, fs_main_src);
    loc_mvp = gl_get_uniform_location(program_main, "mvp");
    loc_uColor = gl_get_uniform_location(program_main, "uColor");
    attr_position_main = gl_get_attrib_location(program_main, "position");

    // Compile and set up infinite grid overlay tracking uniform configurations
    program_grid = compile_shader_program(vs_grid_src, fs_grid_src);
    loc_grid_camOffset = gl_get_uniform_location(program_grid, "u_camOffset");
    loc_grid_zoom = gl_get_uniform_location(program_grid, "u_zoom");
    loc_grid_resolution = gl_get_uniform_location(program_grid, "u_resolution");
    attr_position_grid = gl_get_attrib_location(program_grid, "position");

    // Generate, bind, and cache execution vertex structures directly inside hardware buffers
    vbo_circle = gl_create_buffer();
    gl_bind_buffer(GL_ARRAY_BUFFER, vbo_circle);
    gl_buffer_data(GL_ARRAY_BUFFER, circle_vertices, sizeof(circle_vertices), GL_STATIC_DRAW);

    vbo_box = gl_create_buffer();
    gl_bind_buffer(GL_ARRAY_BUFFER, vbo_box);
    gl_buffer_data(GL_ARRAY_BUFFER, box_vertices, sizeof(box_vertices), GL_STATIC_DRAW);

    float quad_vertices[] = { -1.0f, -1.0f,  1.0f, -1.0f, -1.0f,  1.0f, 
                              -1.0f,  1.0f,  1.0f, -1.0f,  1.0f,  1.0f };
    vbo_quad = gl_create_buffer();
    gl_bind_buffer(GL_ARRAY_BUFFER, vbo_quad);
    gl_buffer_data(GL_ARRAY_BUFFER, quad_vertices, sizeof(quad_vertices), GL_STATIC_DRAW);

    gl_clear_color(1.0f, 1.0f, 1.0f, 1.0f);
}

// Explicit uniform state drivers mapping directly against active pipelines
void set_color(float r, float g, float b) {
    gl_uniform3f(loc_uColor, r, g, b);
}

void update_matrix(const float* matrix_ptr) {
    gl_uniform_matrix4fv(loc_mvp, matrix_ptr);
}

void render_frame(float time) {
    static float last_time = 0.0f;
    float dt = (time - last_time) * 0.001f;
    last_time = time;
    if (dt > 0.05f) dt = 0.05f;

    float base_cam_speed = 14.0f;
    float dynamic_speed = base_cam_speed / cam_zoom;

    if (keys[0]) cam_y += dynamic_speed * dt;
    if (keys[2]) cam_y -= dynamic_speed * dt;
    if (keys[1]) cam_x -= dynamic_speed * dt;
    if (keys[3]) cam_x += dynamic_speed * dt;

    int substeps = 4;
    float sub_dt = dt / (float)substeps;
    for (int step = 0; step < substeps; step++) {
        for (int i = 0; i < active_ball_count; i++) {
            balls[i].pos[0] += balls[i].vel[0] * sub_dt;
            balls[i].pos[1] += balls[i].vel[1] * sub_dt;

            if (balls[i].pos[0] > BOUNDS - BALL_RADIUS) { balls[i].pos[0] = BOUNDS - BALL_RADIUS; balls[i].vel[0] *= -1.0f; }
            else if (balls[i].pos[0] < -BOUNDS + BALL_RADIUS) { balls[i].pos[0] = -BOUNDS + BALL_RADIUS; balls[i].vel[0] *= -1.0f; }
            if (balls[i].pos[1] > BOUNDS - BALL_RADIUS) { balls[i].pos[1] = BOUNDS - BALL_RADIUS; balls[i].vel[1] *= -1.0f; }
            else if (balls[i].pos[1] < -BOUNDS + BALL_RADIUS) { balls[i].pos[1] = -BOUNDS + BALL_RADIUS; balls[i].vel[1] *= -1.0f; }
        }

        for (int i = 0; i < active_ball_count; i++) {
            for (int j = i + 1; j < active_ball_count; j++) {
                float dx = balls[j].pos[0] - balls[i].pos[0];
                float dy = balls[j].pos[1] - balls[i].pos[1];
                float dist_sq = dx * dx + dy * dy;
                float radius_sum = BALL_RADIUS * 2.0f;

                if (dist_sq < radius_sum * radius_sum && dist_sq > 0.0001f) {
                    float dist = sqrtf(dist_sq);
                    float nx = dx / dist;
                    float ny = dy / dist;

                    float overlap = radius_sum - dist;
                    balls[i].pos[0] -= nx * (overlap * 0.5f);
                    balls[i].pos[1] -= ny * (overlap * 0.5f);
                    balls[j].pos[0] += nx * (overlap * 0.5f);
                    balls[j].pos[1] += ny * (overlap * 0.5f);

                    float dvx = balls[j].vel[0] - balls[i].vel[0];
                    float dvy = balls[j].vel[1] - balls[i].vel[1];
                    float vel_along_normal = dvx * nx + dvy * ny;

                    if (vel_along_normal < 0) {
                        float j_impulse = -2.0f * vel_along_normal / 2.0f;
                        balls[i].vel[0] -= nx * j_impulse;
                        balls[i].vel[1] -= ny * j_impulse;
                        balls[j].vel[0] += nx * j_impulse;
                        balls[j].vel[1] += ny * j_impulse;
                    }
                }
            }
        }
    }

    float aspect = (float)screen_width / (float)screen_height;
    float base_view_size = BOUNDS + 1.5f;
    float x_bound = base_view_size;
    float y_bound = base_view_size;
    
    if (aspect > 1.0f) { x_bound *= aspect; } else { y_bound /= aspect; }

    mat4 projection;
    glm_ortho(-x_bound, x_bound, -y_bound, y_bound, -1.0f, 1.0f, projection);

    mat4 view = GLM_MAT4_IDENTITY_INIT;
    glm_scale_uni(view, cam_zoom);
    vec3 translate_vec = {-cam_x, -cam_y, 0.0f};
    glm_translate(view, translate_vec);

    mat4 vp;
    glm_mat4_mul(projection, view, vp);

    // Render Execution - Clear Screen Pipeline
    gl_clear(GL_COLOR_BUFFER_BIT);

    // Render Execution Pass 1: Draw Infinite Grid System Layout
    gl_use_program(program_grid);
    gl_uniform2f(loc_grid_camOffset, cam_x, cam_y);
    gl_uniform1f(loc_grid_zoom, cam_zoom);
    gl_uniform2f(loc_grid_resolution, (float)screen_width, (float)screen_height);

    gl_bind_buffer(GL_ARRAY_BUFFER, vbo_quad);
    gl_vertex_attrib_pointer(attr_position_grid, 2, GL_FLOAT, 0, 0, 0);
    gl_enable_vertex_attrib_array(attr_position_grid);
    gl_draw_arrays(GL_TRIANGLES, 0, 6);

    // Render Execution Pass 2: Draw Simulated Simulation Boundaries and Spheres
    gl_use_program(program_main);
    gl_enable_vertex_attrib_array(attr_position_main);

    // Execution of drawing parameters tracking against container boundaries
    set_color(1.0f, 0.2f, 0.2f);
    update_matrix((float*)vp);

    gl_bind_buffer(GL_ARRAY_BUFFER, vbo_box);
    gl_vertex_attrib_pointer(attr_position_main, 3, GL_FLOAT, 0, 12, 0);
    gl_draw_arrays(GL_LINE_LOOP, 0, 4);

    float visible_half_w = x_bound / cam_zoom;
    float visible_half_h = y_bound / cam_zoom;
    
    float min_visible_x = cam_x - visible_half_w - BALL_RADIUS;
    float max_visible_x = cam_x + visible_half_w + BALL_RADIUS;
    float min_visible_y = cam_y - visible_half_h - BALL_RADIUS;
    float max_visible_y = cam_y + visible_half_h + BALL_RADIUS;

    gl_bind_buffer(GL_ARRAY_BUFFER, vbo_circle);
    gl_vertex_attrib_pointer(attr_position_main, 3, GL_FLOAT, 0, 12, 0);

    for (int i = 0; i < active_ball_count; i++) {
        if (balls[i].pos[0] < min_visible_x || balls[i].pos[0] > max_visible_x ||
            balls[i].pos[1] < min_visible_y || balls[i].pos[1] > max_visible_y) {
            continue; 
        }

        mat4 model = GLM_MAT4_IDENTITY_INIT;
        vec3 translate = {balls[i].pos[0], balls[i].pos[1], 0.0f};
        glm_translate(model, translate);
        glm_scale_uni(model, BALL_RADIUS);

        mat4 mvp;
        glm_mat4_mul(vp, model, mvp);
        
        set_color(balls[i].color[0], balls[i].color[1], balls[i].color[2]);
        update_matrix((float*)mvp);
        
        gl_draw_arrays(GL_TRIANGLE_FAN, 0, 18);
    }
}
