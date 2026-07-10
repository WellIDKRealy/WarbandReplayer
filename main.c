#define CGLM_DEFINE_PRINTS 0

#include <cglm/cglm.h>
#include <cglm/struct.h>

extern void gl_clear();
extern void gl_draw_triangles();
extern void gl_update_matrix(float* matrix_ptr);
extern void js_log_string(const char* msg);
extern void js_log_float(float v);

// Cube Vertex Data: 36 vertices. Layout: X, Y, Z, R, G, B
float cube_vertices[] = {
  // Front face
  -1.0f,-1.0f, 1.0f,  1.0f,0.0f,0.0f,   1.0f,-1.0f, 1.0f,  1.0f,0.0f,0.0f,   1.0f, 1.0f, 1.0f,  1.0f,0.0f,0.0f,
  -1.0f,-1.0f, 1.0f,  1.0f,0.0f,0.0f,   1.0f, 1.0f, 1.0f,  1.0f,0.0f,0.0f,  -1.0f, 1.0f, 1.0f,  1.0f,0.0f,0.0f,
  // Back face
  -1.0f,-1.0f,-1.0f,  0.0f,1.0f,0.0f,  -1.0f, 1.0f,-1.0f,  0.0f,1.0f,0.0f,   1.0f, 1.0f,-1.0f,  0.0f,1.0f,0.0f,
  -1.0f,-1.0f,-1.0f,  0.0f,1.0f,0.0f,   1.0f, 1.0f,-1.0f,  0.0f,1.0f,0.0f,   1.0f,-1.0f,-1.0f,  0.0f,1.0f,0.0f,
  // Top face
  -1.0f, 1.0f,-1.0f,  0.0f,0.0f,1.0f,  -1.0f, 1.0f, 1.0f,  0.0f,0.0f,1.0f,   1.0f, 1.0f, 1.0f,  0.0f,0.0f,1.0f,
  -1.0f, 1.0f,-1.0f,  0.0f,0.0f,1.0f,   1.0f, 1.0f, 1.0f,  0.0f,0.0f,1.0f,   1.0f, 1.0f,-1.0f,  0.0f,0.0f,1.0f,
  // Bottom face
  -1.0f,-1.0f,-1.0f,  1.0f,1.0f,0.0f,   1.0f,-1.0f,-1.0f,  1.0f,1.0f,0.0f,   1.0f,-1.0f, 1.0f,  1.0f,1.0f,0.0f,
  -1.0f,-1.0f,-1.0f,  1.0f,1.0f,0.0f,   1.0f,-1.0f, 1.0f,  1.0f,1.0f,0.0f,  -1.0f,-1.0f, 1.0f,  1.0f,1.0f,0.0f,
  // Right face
  1.0f,-1.0f,-1.0f,  1.0f,0.0f,1.0f,   1.0f, 1.0f,-1.0f,  1.0f,0.0f,1.0f,   1.0f, 1.0f, 1.0f,  1.0f,0.0f,1.0f,
  1.0f,-1.0f,-1.0f,  1.0f,0.0f,1.0f,   1.0f, 1.0f, 1.0f,  1.0f,0.0f,1.0f,   1.0f,-1.0f, 1.0f,  1.0f,0.0f,1.0f,
  // Left face
  -1.0f,-1.0f,-1.0f,  0.0f,1.0f,1.0f,  -1.0f,-1.0f, 1.0f,  0.0f,1.0f,1.0f,  -1.0f, 1.0f, 1.0f,  0.0f,1.0f,1.0f,
  -1.0f,-1.0f,-1.0f,  0.0f,1.0f,1.0f,  -1.0f, 1.0f, 1.0f,  0.0f,1.0f,1.0f,  -1.0f, 1.0f,-1.0f,  0.0f,1.0f,1.0f
};

// Expose memory to JS
float* get_vertices() { return cube_vertices; }
int get_vertex_count() { return 36; }
int get_vertex_byte_size() { return sizeof(cube_vertices); }

void render_frame(float time) {
  float angle = time * 0.001f;

  mat4 projection;
  mat4 view = GLM_MAT4_IDENTITY_INIT;
  mat4 model = GLM_MAT4_IDENTITY_INIT;
  mat4 mvp;

  // Arguments: fovy (radians), aspect, near, far, dest_matrix
  float fovy = 45.0f * (3.14159265f / 180.0f); // 45 degrees in radians
  glm_perspective(fovy, 1.0f, 0.1f, 100.0f, projection);

  // Translation
  vec3 translate_vec = {0.0f, 0.0f, -4.0f};
  glm_translate(view, translate_vec);

  // Rotation
  vec3 axis_x = {1.0f, 0.0f, 0.0f};
  vec3 axis_y = {0.0f, 1.0f, 0.0f};
  glm_rotate(model, angle, axis_x);
  glm_rotate(model, angle * 0.7f, axis_y);

  // Apply transformations
  glm_mat4_mul(projection, view, mvp);
  glm_mat4_mul(mvp, model, mvp);

  // Send to JS
  gl_clear();
  gl_update_matrix((float*)mvp);
  gl_draw_triangles();
}
