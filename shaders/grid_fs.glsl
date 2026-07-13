#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

varying vec2 screenUV;
uniform vec2 u_camOffset;
uniform float u_zoom;
uniform vec2 u_resolution;

#define COLOR_BG    vec4(1.0, 1.0, 1.0, 1.0)
#define COLOR_MAJOR vec4(0.4, 0.4, 0.4, 1.0)
#define COLOR_MINOR vec4(0.7, 0.7, 0.7, 1.0)
#define COLOR_FINE  vec4(0.9, 0.9, 0.9, 1.0)
#define LINE_THICKNESS 1.0

void main() {
    float aspect = u_resolution.x / u_resolution.y;
    vec2 worldPos = screenUV * vec2(13.5 * aspect, 13.5) / u_zoom + u_camOffset;
    
    float logZoom = log(u_zoom) / log(3.0);
    float level = floor(logZoom);
    float f = fract(logZoom);
    
    float scale4 = pow(3.0, -level - 1.0);
    vec2 gridCoord = worldPos / scale4;
    vec2 fragDist = abs(fract(gridCoord - 0.5) - 0.5);
    
    float gridStepPerPixel = 27.0 / (u_resolution.y * u_zoom * scale4);
    vec2 screenDist = fragDist / gridStepPerPixel;
    
    float maskX = smoothstep(LINE_THICKNESS, 0.0, screenDist.x);
    float maskY = smoothstep(LINE_THICKNESS, 0.0, screenDist.y);
    
    float cellX = floor(gridCoord.x + 0.5);
    float cellY = floor(gridCoord.y + 0.5);
    
    vec4 col1 = COLOR_MAJOR;
    vec4 col2 = mix(COLOR_MINOR, COLOR_MAJOR, f);
    vec4 col3 = mix(COLOR_FINE, COLOR_MINOR, f);
    vec4 col4 = mix(COLOR_BG, COLOR_FINE, f);
    
    float lvlX = 4.0;
    vec4 colX = col4;
    if      (abs(cellX - floor(cellX / 27.0 + 0.5) * 27.0) < 0.1) { colX = col1; lvlX = 1.0; }
    else if (abs(cellX - floor(cellX / 9.0 + 0.5)  * 9.0)  < 0.1) { colX = col2; lvlX = 2.0; }
    else if (abs(cellX - floor(cellX / 3.0 + 0.5)  * 3.0)  < 0.1) { colX = col3; lvlX = 3.0; }
    
    float lvlY = 4.0;
    vec4 colY = col4;
    if      (abs(cellY - floor(cellY / 27.0 + 0.5) * 27.0) < 0.1) { colY = col1; lvlY = 1.0; }
    else if (abs(cellY - floor(cellY / 9.0 + 0.5)  * 9.0)  < 0.1) { colY = col2; lvlY = 2.0; }
    else if (abs(cellY - floor(cellY / 3.0 + 0.5)  * 3.0)  < 0.1) { colY = col3; lvlY = 3.0; }
    
    vec4 finalColor = COLOR_BG;
    if (maskX > 0.0 || maskY > 0.0) {
        bool xDominates = (lvlX < lvlY) || (lvlX == lvlY && maskX >= maskY);
        if (xDominates) {
            finalColor = mix(COLOR_BG, colY, maskY);
            finalColor = mix(finalColor, colX, maskX);
        } else {
            finalColor = mix(COLOR_BG, colX, maskX);
            finalColor = mix(finalColor, colY, maskY);
        }
    }
    gl_FragColor = finalColor;
}
