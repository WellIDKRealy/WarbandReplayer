#include "ubench.h"

// Since your project overrides math.h in ./goyslopless-c/include/,
// cglm will automatically use your implementations of sinf, cosf, sqrtf, etc.
#include <cglm/cglm.h>

#define NUM_ELEMENTS 100000

// Pre-allocate buffers to prevent WASM heap allocations during the benchmark
volatile vec3 vectors_in[NUM_ELEMENTS];
volatile vec3 vectors_out[NUM_ELEMENTS];
volatile mat4 matrices_out[NUM_ELEMENTS];
volatile versor quats_out[NUM_ELEMENTS];

#pragma GCC diagnostic push
// This ONLY ignores the dropped 'volatile' (or 'const') qualifier warning
#pragma GCC diagnostic ignored "-Wincompatible-pointer-types-discards-qualifiers"

// 1. Vector Normalization (Stresses: powf, sqrtf)
UBENCH(Graphics_cglm, VectorNormalize) {
  for (int j = 0; j < 100; j++) {
	for (int i = 0; i < NUM_ELEMENTS; i++) {
      // glm_vec3_normalize relies entirely on sqrtf (or your WASM f32.sqrt fallback)
      glm_vec3_normalize_to(vectors_in[i], vectors_out[i]);
	}
  }
}

// 2. 3D Euler Rotation Matrix (Stresses: sinf, cosf)
UBENCH(Graphics_cglm, EulerRotation) {
  vec3 angles = {0.5f, 1.2f, 0.3f}; // Pitch, Yaw, Roll
    
  for (int i = 0; i < NUM_ELEMENTS; i++) {
    // glm_euler_xyz intensely calls sinf and cosf to build the rotation matrix
    glm_euler_xyz(angles, matrices_out[i]);
        
    // Transform the vector using the generated matrix
    glm_mat4_mulv3(matrices_out[i], vectors_in[i], 1.0f, vectors_out[i]);
  }
}

// 3. Perspective Projection (Stresses: tanf)
UBENCH(Graphics_cglm, PerspectiveProjection) {
  for(int j = 0; j < 100; j++) {
	float fov = glm_rad(90.0f); // Uses your fmodf/fabs if glm_rad triggers it, but mostly constants
	float aspect = 16.0f / 9.0f;
	float nearZ = 0.1f;
	float farZ = 1000.0f;
    
	for (int i = 0; i < NUM_ELEMENTS; i++) {
      // glm_perspective directly relies on tanf(fov / 2)
      glm_perspective(fov, aspect, nearZ, farZ, matrices_out[i]);
	}
  }
}

// 4. View Matrix / LookAt (Stresses: sqrtf, cross products, f32 ops)
UBENCH(Graphics_cglm, CameraLookAt) {
  for(int j = 0; j < 100; j++) {
	vec3 up = {0.0f, 1.0f, 0.0f};
	vec3 target_offset = {1.0f, -0.5f, 2.0f};
    
	for (int i = 0; i < NUM_ELEMENTS; i++) {
      vec3 target;
      glm_vec3_add(vectors_in[i], target_offset, target);
        
      // glm_lookat stresses vector subtraction, cross products, and normalization (sqrtf)
      glm_lookat(vectors_in[i], target, up, matrices_out[i]);
	}
  }
}

// 5. Quaternion & Euler Conversions (Stresses: asinf, atan2f, sinf, cosf)
UBENCH(Graphics_cglm, QuatEulerConversions) {
  for (int i = 0; i < NUM_ELEMENTS; i++) {
    // Create an euler angle vector from our random inputs
    vec3 euler_in = { 
      vectors_in[i][0] * 0.01f, 
      vectors_in[i][1] * 0.01f, 
      vectors_in[i][2] * 0.01f 
    };
        
    // euler to quat uses sinf, cosf
    glm_euler_xyz_quat(euler_in, quats_out[i]);
        
    // quat to euler heavily stresses asinf and atan2f
	mat4 temp_rot;
	glm_quat_mat4(quats_out[i], temp_rot);
	glm_euler_angles(temp_rot, vectors_out[i]);
  }
}

#pragma GCC diagnostic pop

UBENCH_STATE();

int main(void) {
  // Generate deterministic pseudo-random geometry data
  for (int i = 0; i < NUM_ELEMENTS; i++) {
    vectors_in[i][0] = (float)(i % 100) * 0.1f - 5.0f;
    vectors_in[i][1] = (float)(i % 50)  * 0.2f - 5.0f;
    vectors_in[i][2] = (float)(i % 10)  * 1.5f + 0.1f; // Avoid zero length
  }
    
  return ubench_main(0, 0);
}
