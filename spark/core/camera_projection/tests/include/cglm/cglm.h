/* Minimal stand-in for the cglm functions that the OLD main.c calls (the cglm git submodule is not
 * checked out in this tree).  main.c only uses them to build the GL view-projection matrix inside
 * render_frame; none of them touches the camera state compared by the tests (cam_x, cam_y, zoom, shift,
 * screen size, keys, map bounds), so a portable re-implementation of the same textbook formulas is
 * enough to let the real render_frame run natively.  float, no SIMD. */
#ifndef CAMERA_PROJECTION_TEST_CGLM_H
#define CAMERA_PROJECTION_TEST_CGLM_H
typedef float vec3[3];
typedef float vec4[4];
typedef vec4  mat4[4];
#define GLM_MAT4_IDENTITY_INIT {{1.0f,0.0f,0.0f,0.0f},{0.0f,1.0f,0.0f,0.0f},{0.0f,0.0f,1.0f,0.0f},{0.0f,0.0f,0.0f,1.0f}}

static inline void glm_ortho(float left, float right, float bottom, float top, float nearVal, float farVal, mat4 dest) {
    float rl = 1.0f / (right - left), tb = 1.0f / (top - bottom), fn = -1.0f / (farVal - nearVal);
    for (int i = 0; i < 4; i++) for (int j = 0; j < 4; j++) dest[i][j] = 0.0f;
    dest[0][0] = 2.0f * rl;  dest[1][1] = 2.0f * tb;  dest[2][2] = 2.0f * fn;
    dest[3][0] = -(right + left) * rl;  dest[3][1] = -(top + bottom) * tb;  dest[3][2] = (farVal + nearVal) * fn;
    dest[3][3] = 1.0f;
}
static inline void glm_scale_uni(mat4 m, float s) {
    for (int c = 0; c < 3; c++) for (int r = 0; r < 4; r++) m[c][r] *= s;
}
static inline void glm_translate(mat4 m, vec3 v) {
    for (int r = 0; r < 4; r++) m[3][r] = m[0][r] * v[0] + m[1][r] * v[1] + m[2][r] * v[2] + m[3][r];
}
static inline void glm_mat4_mul(mat4 a, mat4 b, mat4 dest) {
    mat4 t;
    for (int c = 0; c < 4; c++) for (int r = 0; r < 4; r++)
        t[c][r] = a[0][r] * b[c][0] + a[1][r] * b[c][1] + a[2][r] * b[c][2] + a[3][r] * b[c][3];
    for (int c = 0; c < 4; c++) for (int r = 0; r < 4; r++) dest[c][r] = t[c][r];
}
#endif
