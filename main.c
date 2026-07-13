#include <math.h>
#include <cglm/cglm.h>

extern void gl_clear();
extern void gl_draw_circle();
extern void gl_draw_box();
extern void gl_update_matrix(float* matrix_ptr);
extern void gl_set_color(float r, float g, float b);
extern void js_log_string(const char* msg);

#define NUM_BALLS 60
#define BOUNDS 12.0f
#define BALL_RADIUS 0.5f
#define CIRCLE_SEGS 16

float circle_vertices[(CIRCLE_SEGS + 2) * 3];
float box_vertices[4 * 3];

float* get_circle_vertices() { return circle_vertices; }
float* get_box_vertices() { return box_vertices; }

typedef struct {
    vec2 pos;
    vec2 vel;
    vec3 color;
} Ball;

Ball balls[NUM_BALLS];

// --- Engine State Tracking ---
float cam_x = 0.0f;
float cam_y = 0.0f;
float cam_zoom = 1.0f;
int screen_width = 800;
int screen_height = 600;
int keys[4] = {0, 0, 0, 0};
int active_ball_count = 0;

// --- File Handling and Custom Parsing Memory ---
char file_input_buffer[65536]; 
int uploaded_file_bytes = 0;
int ongoing_loading_step = 0;
int targeted_loading_steps = 180; // Artificial delay depth

char* get_file_buffer_ptr() { return file_input_buffer; }
int get_file_buffer_max_size() { return sizeof(file_input_buffer); }

// Raw sequential char-stream parser
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

// Replace your existing prepare_simulation_loading function with this:
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
        // Skip any leading layout delimiters or blank padding lines
        while (file_input_buffer[cursor_index] == ' ' || file_input_buffer[cursor_index] == ',' || 
               file_input_buffer[cursor_index] == '\n' || file_input_buffer[cursor_index] == '\r' || 
               file_input_buffer[cursor_index] == '\t') {
            cursor_index++;
        }
        
        // Break instantly if we reach the end of valid data text lines
        if (file_input_buffer[cursor_index] == '\0') {
            break;
        }

        int start_pos = cursor_index;
        balls[active_ball_count].pos[0] = parse_float(file_input_buffer, &cursor_index);
        balls[active_ball_count].pos[1] = parse_float(file_input_buffer, &cursor_index);
        
        // Safety guard against unparseable lines causing an infinite loop
        if (cursor_index == start_pos) break;

        // Populate kinematic attributes specifically for this active ball index
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

        // ARTIFICIAL BURDEN: Simulated heavy calculation footprint
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
    if (delta_y > 0) {
        cam_zoom *= 0.88f; // Smooth zoom out
    } else if (delta_y < 0) {
        cam_zoom *= 1.12f; // Smooth zoom in
    }
    if (cam_zoom < 0.1f) cam_zoom = 0.1f;
    if (cam_zoom > 25.0f) cam_zoom = 25.0f;
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

void render_frame(float time) {
    static float last_time = 0.0f;
    float dt = (time - last_time) * 0.001f;
    last_time = time;
    if (dt > 0.05f) dt = 0.05f;

    // Camera adjustments map speed inversely to zoom factors
    float base_cam_speed = 14.0f;
    float dynamic_speed = base_cam_speed / cam_zoom;

    if (keys[0]) cam_y += dynamic_speed * dt;
    if (keys[2]) cam_y -= dynamic_speed * dt;
    if (keys[1]) cam_x -= dynamic_speed * dt;
    if (keys[3]) cam_x += dynamic_speed * dt;

    // --- PHYSICS ENGINE SUBSYSTEM ---
    int substeps = 4;
    float sub_dt = dt / (float)substeps;
    for (int step = 0; step < substeps; step++) {
        // 1. Position integration and wall constraints
        for (int i = 0; i < active_ball_count; i++) {
            balls[i].pos[0] += balls[i].vel[0] * sub_dt;
            balls[i].pos[1] += balls[i].vel[1] * sub_dt;

            if (balls[i].pos[0] > BOUNDS - BALL_RADIUS) { balls[i].pos[0] = BOUNDS - BALL_RADIUS; balls[i].vel[0] *= -1.0f; }
            else if (balls[i].pos[0] < -BOUNDS + BALL_RADIUS) { balls[i].pos[0] = -BOUNDS + BALL_RADIUS; balls[i].vel[0] *= -1.0f; }
            if (balls[i].pos[1] > BOUNDS - BALL_RADIUS) { balls[i].pos[1] = BOUNDS - BALL_RADIUS; balls[i].vel[1] *= -1.0f; }
            else if (balls[i].pos[1] < -BOUNDS + BALL_RADIUS) { balls[i].pos[1] = -BOUNDS + BALL_RADIUS; balls[i].vel[1] *= -1.0f; }
        }

        // 2. Pairwise Ball-to-Ball Elastic Collisions
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

                    // Resolve geometric intersection overlaps immediately
                    float overlap = radius_sum - dist;
                    balls[i].pos[0] -= nx * (overlap * 0.5f);
                    balls[i].pos[1] -= ny * (overlap * 0.5f);
                    balls[j].pos[0] += nx * (overlap * 0.5f);
                    balls[j].pos[1] += ny * (overlap * 0.5f);

                    // Elastic impulse handling
                    float dvx = balls[j].vel[0] - balls[i].vel[0];
                    float dvy = balls[j].vel[1] - balls[i].vel[1];
                    float vel_along_normal = dvx * nx + dvy * ny;

                    if (vel_along_normal < 0) {
                        float j_impulse = -2.0f * vel_along_normal / 2.0f; // Equal mass configuration
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

    gl_set_color(1.0f, 0.2f, 0.2f);
    gl_update_matrix((float*)vp);
    gl_draw_box();

    // --- FRUSTUM CULLING CHECK ---
    float visible_half_w = x_bound / cam_zoom;
    float visible_half_h = y_bound / cam_zoom;
    
    float min_visible_x = cam_x - visible_half_w - BALL_RADIUS;
    float max_visible_x = cam_x + visible_half_w + BALL_RADIUS;
    float min_visible_y = cam_y - visible_half_h - BALL_RADIUS;
    float max_visible_y = cam_y + visible_half_h + BALL_RADIUS;

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
        
        gl_set_color(balls[i].color[0], balls[i].color[1], balls[i].color[2]);
        gl_update_matrix((float*)mvp);
        gl_draw_circle();
    }
}
