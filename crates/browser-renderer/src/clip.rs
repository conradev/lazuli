//! Ordered f32 homogeneous clipping for exact GX triangle coverage.
//!
//! This mirrors Dolphin's software clipper operation by operation.  The
//! unusual positive-Z mask and W-plane walk are intentional compatibility
//! behavior, as are culling before clipping and retaining duplicate boundary
//! vertices during the literal polygon walk.

use std::fmt;

mod project;

const GX_CLIP_COMPONENTS: usize = 4;
const GX_CLIP_PLANE_MASK: u8 = 0x3f;
const GX_CLIP_PLANES: [(u8, [f32; 4]); 6] = [
    (0x01, [-1.0, 0.0, 0.0, 1.0]),
    (0x02, [1.0, 0.0, 0.0, 1.0]),
    (0x04, [0.0, -1.0, 0.0, 1.0]),
    (0x08, [0.0, 1.0, 0.0, 1.0]),
    // Dolphin's triangle clipper intentionally walks W >= 0 for +Z.
    (0x10, [0.0, 0.0, 0.0, 1.0]),
    (0x20, [0.0, 0.0, 1.0, 1.0]),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GxClipError {
    InvalidComponentCount,
    UnsupportedTopology(u8),
    NoSourceTriangles,
    InvalidCullMode(u8),
    InvalidViewportHeight,
    NonFiniteVertex,
    ArithmeticOverflow,
}

impl fmt::Display for GxClipError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidComponentCount => {
                write!(formatter, "GX clip vertices require at least XYZW")
            }
            Self::UnsupportedTopology(topology) => {
                write!(formatter, "unsupported GX clip topology {topology}")
            }
            Self::NoSourceTriangles => write!(formatter, "GX clip input has no source triangles"),
            Self::InvalidCullMode(cull_mode) => {
                write!(formatter, "invalid GX clip cull mode {cull_mode}")
            }
            Self::InvalidViewportHeight => {
                write!(
                    formatter,
                    "GX clip viewport height must be finite and nonzero"
                )
            }
            Self::NonFiniteVertex => write!(formatter, "non-finite GX clip vertex"),
            Self::ArithmeticOverflow => write!(formatter, "GX clip arithmetic overflow"),
        }
    }
}

impl std::error::Error for GxClipError {}

#[inline]
fn gx_add(left: f32, right: f32) -> f32 {
    left + right
}

#[inline]
fn gx_sub(left: f32, right: f32) -> f32 {
    left - right
}

#[inline]
fn gx_mul(left: f32, right: f32) -> f32 {
    left * right
}

#[inline]
fn gx_div(left: f32, right: f32) -> f32 {
    left / right
}

fn gx_dot4(row: [f32; 4], vector: &[f32]) -> f32 {
    gx_add(
        gx_add(
            gx_add(gx_mul(row[0], vector[0]), gx_mul(row[1], vector[1])),
            gx_mul(row[2], vector[2]),
        ),
        gx_mul(row[3], vector[3]),
    )
}

fn gx_clip_vertex_is_valid<const COMPONENTS: usize>(vertex: &[f32; COMPONENTS]) -> bool {
    COMPONENTS >= GX_CLIP_COMPONENTS && vertex.iter().all(|component| component.is_finite())
}

fn gx_clip_mask<const COMPONENTS: usize>(vertex: &[f32; COMPONENTS]) -> Result<u8, GxClipError> {
    if !gx_clip_vertex_is_valid(vertex) {
        return Err(if COMPONENTS < GX_CLIP_COMPONENTS {
            GxClipError::InvalidComponentCount
        } else {
            GxClipError::NonFiniteVertex
        });
    }
    let [x, y, z, w] = [vertex[0], vertex[1], vertex[2], vertex[3]];
    let mut mask = 0;
    if gx_sub(w, x) < 0.0 {
        mask |= 0x01;
    }
    if gx_add(x, w) < 0.0 {
        mask |= 0x02;
    }
    if gx_sub(w, y) < 0.0 {
        mask |= 0x04;
    }
    if gx_add(y, w) < 0.0 {
        mask |= 0x08;
    }
    if gx_mul(w, z) > 0.0 {
        mask |= 0x10;
    }
    if gx_add(z, w) < 0.0 {
        mask |= 0x20;
    }
    Ok(mask)
}

fn gx_clip_normal_z<const COMPONENTS: usize>(
    triangle: &[[f32; COMPONENTS]; 3],
) -> Result<f32, GxClipError> {
    let [v0, v1, v2] = triangle;
    let term0 = gx_mul(gx_sub(gx_mul(v0[0], v2[3]), gx_mul(v2[0], v0[3])), v1[1]);
    let term1 = gx_mul(gx_sub(gx_mul(v2[0], v0[1]), gx_mul(v0[0], v2[1])), v1[3]);
    let term2 = gx_mul(gx_sub(gx_mul(v2[1], v0[3]), gx_mul(v0[1], v2[3])), v1[0]);
    let normal = gx_add(gx_add(term0, term1), term2);
    normal
        .is_finite()
        .then_some(normal)
        .ok_or(GxClipError::ArithmeticOverflow)
}

fn gx_clip_different_signs(left: f32, right: f32) -> bool {
    (left <= 0.0 && right > 0.0) || (left > 0.0 && right <= 0.0)
}

fn gx_clip_plane_distance<const COMPONENTS: usize>(
    vertex: &[f32; COMPONENTS],
    plane: [f32; 4],
) -> Result<f32, GxClipError> {
    let distance = gx_dot4(plane, vertex);
    distance
        .is_finite()
        .then_some(distance)
        .ok_or(GxClipError::ArithmeticOverflow)
}

fn gx_clip_intersection<const COMPONENTS: usize>(
    t: f32,
    out_vertex: [f32; COMPONENTS],
    in_vertex: [f32; COMPONENTS],
) -> Result<[f32; COMPONENTS], GxClipError> {
    if !t.is_finite() || !(0.0..=1.0).contains(&t) {
        return Err(GxClipError::ArithmeticOverflow);
    }
    let mut vertex = [0.0; COMPONENTS];
    for component in 0..COMPONENTS {
        vertex[component] = gx_add(
            out_vertex[component],
            gx_mul(gx_sub(in_vertex[component], out_vertex[component]), t),
        );
    }
    vertex
        .iter()
        .all(|component| component.is_finite())
        .then_some(vertex)
        .ok_or(GxClipError::ArithmeticOverflow)
}

fn gx_clip_polygon<const COMPONENTS: usize>(
    vertices: [[f32; COMPONENTS]; 3],
    mask: u8,
) -> Result<Vec<[f32; COMPONENTS]>, GxClipError> {
    if mask & !GX_CLIP_PLANE_MASK != 0 {
        return Err(GxClipError::ArithmeticOverflow);
    }
    let mut input = vertices.to_vec();
    for (plane_bit, plane) in GX_CLIP_PLANES {
        if mask & plane_bit == 0 {
            continue;
        }
        let mut output = Vec::with_capacity(input.len() + 1);
        let mut previous = input[0];
        let mut previous_distance = gx_clip_plane_distance(&previous, plane)?;
        for index in 1..=input.len() {
            let current = input[index % input.len()];
            let distance = gx_clip_plane_distance(&current, plane)?;
            if previous_distance >= 0.0 {
                output.push(previous);
            }
            if gx_clip_different_signs(distance, previous_distance) {
                let (t, out_vertex, in_vertex) = if distance < 0.0 {
                    (
                        gx_div(distance, gx_sub(distance, previous_distance)),
                        current,
                        previous,
                    )
                } else {
                    (
                        gx_div(previous_distance, gx_sub(previous_distance, distance)),
                        previous,
                        current,
                    )
                };
                output.push(gx_clip_intersection(t, out_vertex, in_vertex)?);
            }
            previous = current;
            previous_distance = distance;
        }
        if output.len() < 3 {
            return Ok(Vec::new());
        }
        input = output;
    }
    Ok(input)
}

fn gx_triangulate_polygon<const COMPONENTS: usize>(
    polygon: &[[f32; COMPONENTS]],
) -> Vec<[[f32; COMPONENTS]; 3]> {
    if polygon.len() < 3 {
        return Vec::new();
    }
    let mut triangles = Vec::with_capacity(polygon.len() - 2);
    triangles.push([polygon[0], polygon[1], polygon[2]]);
    for vertex in 3..polygon.len() {
        triangles.push([polygon[0], polygon[vertex - 1], polygon[vertex]]);
    }
    triangles
}

fn gx_post_clip_triangle<const COMPONENTS: usize>(
    triangle: [[f32; COMPONENTS]; 3],
    cull_mode: u8,
    viewport_height: f32,
) -> Result<Vec<[[f32; COMPONENTS]; 3]>, GxClipError> {
    let masks = [
        gx_clip_mask(&triangle[0])?,
        gx_clip_mask(&triangle[1])?,
        gx_clip_mask(&triangle[2])?,
    ];
    if masks[0] & masks[1] & masks[2] != 0 {
        return Ok(Vec::new());
    }

    let normal = gx_clip_normal_z(&triangle)?;
    let mut backface = normal <= 0.0;
    if viewport_height > 0.0 {
        backface = !backface;
    }
    let survives = cull_mode == 0 || (cull_mode == 1 && backface) || (cull_mode == 2 && !backface);
    if !survives {
        return Ok(Vec::new());
    }

    let ordered = if backface {
        [triangle[0], triangle[2], triangle[1]]
    } else {
        triangle
    };
    let polygon = gx_clip_polygon(ordered, masks[0] | masks[1] | masks[2])?;
    Ok(gx_triangulate_polygon(&polygon))
}

fn gx_source_triangle_indices(topology: u8, vertex_count: usize) -> Vec<[usize; 3]> {
    match topology {
        0 | 1 => {
            let mut triangles =
                Vec::with_capacity(vertex_count / 4 * 2 + usize::from(vertex_count % 4 == 3));
            for base in (0..vertex_count / 4 * 4).step_by(4) {
                triangles.push([base, base + 1, base + 2]);
                triangles.push([base, base + 2, base + 3]);
            }
            if vertex_count % 4 == 3 {
                let base = vertex_count - 3;
                triangles.push([base, base + 1, base + 2]);
            }
            triangles
        }
        2 => (0..vertex_count / 3)
            .map(|triangle| {
                let base = triangle * 3;
                [base, base + 1, base + 2]
            })
            .collect(),
        3 => (0..vertex_count.saturating_sub(2))
            .map(|triangle| {
                let end = triangle + 2;
                if end % 2 == 0 {
                    [end - 2, end - 1, end]
                } else {
                    [end - 2, end, end - 1]
                }
            })
            .collect(),
        4 => (0..vertex_count.saturating_sub(2))
            .map(|triangle| [0, triangle + 1, triangle + 2])
            .collect(),
        _ => Vec::new(),
    }
}

/// Expands one GX triangle primitive and returns its post-cull, post-clip fan
/// triangles. Components after XYZW are interpolated in the same ordered f32
/// walk and are otherwise opaque to the clipper.
pub(crate) fn gx_exact_clip_triangles<const COMPONENTS: usize>(
    topology: u8,
    vertices: &[[f32; COMPONENTS]],
    cull_mode: u8,
    viewport_height: f32,
) -> Result<Vec<[[f32; COMPONENTS]; 3]>, GxClipError> {
    if COMPONENTS < GX_CLIP_COMPONENTS {
        return Err(GxClipError::InvalidComponentCount);
    }
    if topology > 4 {
        return Err(GxClipError::UnsupportedTopology(topology));
    }
    if cull_mode > 3 {
        return Err(GxClipError::InvalidCullMode(cull_mode));
    }
    if !viewport_height.is_finite() || viewport_height == 0.0 {
        return Err(GxClipError::InvalidViewportHeight);
    }
    if vertices
        .iter()
        .flatten()
        .any(|component| !component.is_finite())
    {
        return Err(GxClipError::NonFiniteVertex);
    }

    let source_triangles = gx_source_triangle_indices(topology, vertices.len());
    if source_triangles.is_empty() {
        return Err(GxClipError::NoSourceTriangles);
    }
    let mut clipped = Vec::new();
    for indices in source_triangles {
        clipped.extend(gx_post_clip_triangle(
            [
                vertices[indices[0]],
                vertices[indices[1]],
                vertices[indices[2]],
            ],
            cull_mode,
            viewport_height,
        )?);
    }
    Ok(clipped)
}

#[cfg(test)]
mod tests;
