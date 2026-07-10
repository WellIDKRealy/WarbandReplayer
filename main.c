#include <cglm/cglm.h>
#include <math.h>

extern void gl_clear();
extern void gl_draw_circle();
extern void gl_draw_box();
extern void gl_update_matrix(float* matrix_ptr);
extern void gl_set_color(float r, float g, float b);

#define NUM_BALLS 50
#define BOUNDS 10.0f
#define BALL_RADIUS 0.4f
#define CIRCLE_SEGS 16

// Geometry Buffers (X, Y, Z only = 3 floats per vertex)
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

// LCG PRNG
static unsigned int prng_seed = 12345;
float rand_float_normalized() {
    prng_seed = (1103515245 * prng_seed + 12345);
    return ((float)(prng_seed & 0x7fffffff) / (float)0x7fffffff) * 2.0f - 1.0f; 
}

// Generate the 2D shapes on WebAssembly start
void init_engine() {
    // 1. Circle (Triangle Fan)
    circle_vertices[0] = 0.0f; circle_vertices[1] = 0.0f; circle_vertices[2] = 0.0f; // Center
    for (int i = 0; i <= CIRCLE_SEGS; i++) {
        float angle = 2.0f * 3.14159265f * ((float)i / CIRCLE_SEGS);
        int idx = (i + 1) * 3;
        circle_vertices[idx + 0] = cosf(angle);
        circle_vertices[idx + 1] = sinf(angle);
        circle_vertices[idx + 2] = 0.0f;
    }

    // 2. Box Bounds (Line Loop)
    float b = BOUNDS;
    float box[] = {
        -b, -b, 0.0f,
         b, -b, 0.0f,
         b,  b, 0.0f,
        -b,  b, 0.0f
    };
    for(int i = 0; i < 12; i++) box_vertices[i] = box[i];

    // 3. Initialize Balls
    for (int i = 0; i < NUM_BALLS; i++) {
        balls[i].pos[0] = rand_float_normalized() * (BOUNDS - BALL_RADIUS * 2.0f);
        balls[i].pos[1] = rand_float_normalized() * (BOUNDS - BALL_RADIUS * 2.0f);
        balls[i].vel[0] = rand_float_normalized() * 12.0f;
        balls[i].vel[1] = rand_float_normalized() * 12.0f;
        // Random Pastel Colors
        balls[i].color[0] = rand_float_normalized() * 0.4f + 0.6f;
        balls[i].color[1] = rand_float_normalized() * 0.4f + 0.6f;
        balls[i].color[2] = rand_float_normalized() * 0.4f + 0.6f;
    }
}

void render_frame(float time) {
    static float last_time = 0.0f;
    float dt = (time - last_time) * 0.001f;
    last_time = time;
    if (dt > 0.05f) dt = 0.05f; // Prevent tunneling on lag

    // --- PHYSICS ENGINE ---
    // We run the physics loop in smaller sub-steps to ensure high-speed balls don't clip through each other
    int substeps = 4;
    float sub_dt = dt / (float)substeps;

    for (int step = 0; step < substeps; step++) {
        for (int i = 0; i < NUM_BALLS; i++) {
            balls[i].pos[0] += balls[i].vel[0] * sub_dt;
            balls[i].pos[1] += balls[i].vel[1] * sub_dt;

            // 1. Wall Collisions
            if (balls[i].pos[0] > BOUNDS - BALL_RADIUS) {
                balls[i].pos[0] = BOUNDS - BALL_RADIUS;
                balls[i].vel[0] *= -1.0f;
            } else if (balls[i].pos[0] < -BOUNDS + BALL_RADIUS) {
                balls[i].pos[0] = -BOUNDS + BALL_RADIUS;
                balls[i].vel[0] *= -1.0f;
            }
            if (balls[i].pos[1] > BOUNDS - BALL_RADIUS) {
                balls[i].pos[1] = BOUNDS - BALL_RADIUS;
                balls[i].vel[1] *= -1.0f;
            } else if (balls[i].pos[1] < -BOUNDS + BALL_RADIUS) {
                balls[i].pos[1] = -BOUNDS + BALL_RADIUS;
                balls[i].vel[1] *= -1.0f;
            }
        }

        // 2. Ball-to-Ball Collisions (O(N^2) checks)
        for (int i = 0; i < NUM_BALLS; i++) {
            for (int j = i + 1; j < NUM_BALLS; j++) {
                float dx = balls[j].pos[0] - balls[i].pos[0];
                float dy = balls[j].pos[1] - balls[i].pos[1];
                float dist_sq = dx * dx + dy * dy;
                float radius_sum = BALL_RADIUS * 2.0f;

                if (dist_sq < radius_sum * radius_sum && dist_sq > 0.0001f) {
                    float dist = sqrtf(dist_sq);
                    float nx = dx / dist;
                    float ny = dy / dist;

                    // A: Positional Correction (Prevents getting stuck inside each other)
                    float overlap = radius_sum - dist;
                    float cx = nx * (overlap * 0.5f);
                    float cy = ny * (overlap * 0.5f);
                    balls[i].pos[0] -= cx;
                    balls[i].pos[1] -= cy;
                    balls[j].pos[0] += cx;
                    balls[j].pos[1] += cy;

                    // B: Elastic Velocity Transfer
                    float dvx = balls[j].vel[0] - balls[i].vel[0];
                    float dvy = balls[j].vel[1] - balls[i].vel[1];
                    float vel_along_normal = dvx * nx + dvy * ny;

                    if (vel_along_normal < 0) { // Only bounce if they are moving towards each other
                        float j_impulse = -2.0f * vel_along_normal / 2.0f; // Assumes mass = 1 for all
                        float jnx = nx * j_impulse;
                        float jny = ny * j_impulse;
                        balls[i].vel[0] -= jnx;
                        balls[i].vel[1] -= jny;
                        balls[j].vel[0] += jnx;
                        balls[j].vel[1] += jny;
                    }
                }
            }
        }
    }

    // --- RENDERING ---
    gl_clear();

    // 2D Orthographic Projection Matrix
    mat4 projection;
    float padding = 1.0f;
    glm_ortho(-BOUNDS - padding, BOUNDS + padding, -BOUNDS - padding, BOUNDS + padding, -1.0f, 1.0f, projection);

    // Draw Bounds (Box)
    gl_set_color(1.0f, 0.0f, 0.0f); // Red bounds
    gl_update_matrix((float*)projection);
    gl_draw_box();

    // Draw Balls
    for (int i = 0; i < NUM_BALLS; i++) {
        mat4 model = GLM_MAT4_IDENTITY_INIT;
        vec3 translate = {balls[i].pos[0], balls[i].pos[1], 0.0f};
        glm_translate(model, translate);
        glm_scale_uni(model, BALL_RADIUS);

        mat4 mvp;
        glm_mat4_mul(projection, model, mvp);
        
        gl_set_color(balls[i].color[0], balls[i].color[1], balls[i].color[2]);
        gl_update_matrix((float*)mvp);
        gl_draw_circle();
    }
}
