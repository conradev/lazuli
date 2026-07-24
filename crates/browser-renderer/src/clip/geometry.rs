//! Composition of transported GX clip positions and native TEV payloads.
//!
//! This layer remains independent of the live WebGPU submission path.  It
//! qualifies the exact state, carries native attributes through the ordered
//! homogeneous clip walk, projects into local EFB coordinates, and retains
//! the conservative managed-coverage restrictions needed by the current
//! shader.

use std::fmt;

use super::project::{GxExactProjectionError, GxExactProjectionState};
use super::{GxClipError, gx_post_clip_triangle, gx_source_triangle_indices};
use crate::packet::{GxDraw, GxExactClipState};
use crate::tev::TEV_VERTEX_FLOATS;
use crate::{EFB_HEIGHT, EFB_WIDTH, GX_DEPTH24_MAX, GxRasterScissor};

const GX_EXACT_CLIP_PAYLOAD_FLOATS: usize = 4 + (TEV_VERTEX_FLOATS - 12);
const GX_GEN_MODE_MULTISAMPLING: u32 = 1 << 9;
const GX_GEN_MODE_CULL_SHIFT: u32 = 14;
const GX_GEN_MODE_CULL_MASK: u32 = 3;
const GX_GEN_MODE_Z_FREEZE: u32 = 1 << 19;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GxExactGeometryError {
    InvalidVertexLayout,
    MissingExactClipInput,
    PositionCountMismatch,
    NonFiniteSourceVertex,
    CullModeStateMismatch,
    UnsupportedMultisampling,
    UnsupportedZFreeze,
    UnsupportedSourceRaster,
    UnsupportedPostClipW,
    UnsupportedPostClipPosition,
    UnsupportedPostClipDepth,
    Clip(GxClipError),
    Projection(GxExactProjectionError),
}

impl fmt::Display for GxExactGeometryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidVertexLayout => write!(formatter, "invalid GX TEV vertex layout"),
            Self::MissingExactClipInput => write!(formatter, "GX draw has no exact clip input"),
            Self::PositionCountMismatch => {
                write!(formatter, "GX clip positions do not match TEV vertices")
            }
            Self::NonFiniteSourceVertex => write!(formatter, "non-finite GX TEV source vertex"),
            Self::CullModeStateMismatch => {
                write!(
                    formatter,
                    "GX exact state cull mode does not match the draw"
                )
            }
            Self::UnsupportedMultisampling => {
                write!(formatter, "multisampled GX coverage is not yet exact")
            }
            Self::UnsupportedZFreeze => write!(formatter, "GX Z-freeze is not yet exact"),
            Self::UnsupportedSourceRaster => {
                write!(formatter, "GX source raster channels are not flat")
            }
            Self::UnsupportedPostClipW => {
                write!(formatter, "GX post-clip W is not strictly positive")
            }
            Self::UnsupportedPostClipPosition => {
                write!(formatter, "GX post-clip position leaves the EFB")
            }
            Self::UnsupportedPostClipDepth => {
                write!(formatter, "GX post-clip depth leaves the 24-bit EFB range")
            }
            Self::Clip(error) => write!(formatter, "{error}"),
            Self::Projection(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for GxExactGeometryError {}

impl From<GxClipError> for GxExactGeometryError {
    fn from(error: GxClipError) -> Self {
        Self::Clip(error)
    }
}

impl From<GxExactProjectionError> for GxExactGeometryError {
    fn from(error: GxExactProjectionError) -> Self {
        Self::Projection(error)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct GxExactRasterGeometry {
    vertices: Vec<f32>,
    source_indices: Vec<[usize; 3]>,
    raster_scissor: GxRasterScissor,
}

impl GxExactRasterGeometry {
    pub(crate) fn vertices(&self) -> &[f32] {
        &self.vertices
    }

    pub(crate) fn into_vertices(self) -> Vec<f32> {
        self.vertices
    }

    pub(crate) fn triangle_count(&self) -> usize {
        self.vertices.len() / (TEV_VERTEX_FLOATS * 3)
    }

    pub(crate) fn source_indices(&self) -> &[[usize; 3]] {
        &self.source_indices
    }

    pub(crate) const fn raster_scissor(&self) -> GxRasterScissor {
        self.raster_scissor
    }

    pub(crate) const fn scissor_rect(&self) -> [u16; 4] {
        self.raster_scissor.rect()
    }
}

pub(crate) fn gx_exact_draw_raster_geometry(
    draw: GxDraw<'_>,
    source_vertices: &[f32],
) -> Result<GxExactRasterGeometry, GxExactGeometryError> {
    let exact = draw
        .exact_clip_input
        .ok_or(GxExactGeometryError::MissingExactClipInput)?;
    let clip_positions = exact.positions().collect::<Vec<_>>();
    gx_exact_raster_geometry(
        draw.record.topology,
        draw.record.cull_mode,
        source_vertices,
        &clip_positions,
        exact.state,
    )
}

fn gx_exact_raster_geometry(
    topology: u8,
    cull_mode: u8,
    source_vertices: &[f32],
    clip_positions: &[[f32; 4]],
    state: GxExactClipState,
) -> Result<GxExactRasterGeometry, GxExactGeometryError> {
    if source_vertices.is_empty() || !source_vertices.len().is_multiple_of(TEV_VERTEX_FLOATS) {
        return Err(GxExactGeometryError::InvalidVertexLayout);
    }
    let vertex_count = source_vertices.len() / TEV_VERTEX_FLOATS;
    if clip_positions.len() != vertex_count {
        return Err(GxExactGeometryError::PositionCountMismatch);
    }
    if source_vertices
        .iter()
        .any(|component| !component.is_finite())
    {
        return Err(GxExactGeometryError::NonFiniteSourceVertex);
    }
    if topology > 4 {
        return Err(GxClipError::UnsupportedTopology(topology).into());
    }
    if cull_mode > 3 {
        return Err(GxClipError::InvalidCullMode(cull_mode).into());
    }

    if ((state.bp_gen_mode >> GX_GEN_MODE_CULL_SHIFT) & GX_GEN_MODE_CULL_MASK)
        != u32::from(cull_mode)
    {
        return Err(GxExactGeometryError::CullModeStateMismatch);
    }
    if state.bp_gen_mode & GX_GEN_MODE_MULTISAMPLING != 0 {
        return Err(GxExactGeometryError::UnsupportedMultisampling);
    }
    if state.bp_gen_mode & GX_GEN_MODE_Z_FREEZE != 0 {
        return Err(GxExactGeometryError::UnsupportedZFreeze);
    }
    let projection = match GxExactProjectionState::qualify(state) {
        Ok(projection) => projection,
        Err(GxExactProjectionError::NoVisibleScissor) => {
            return Ok(gx_exact_empty_geometry());
        }
        Err(error) => return Err(error.into()),
    };

    let source_triangles = gx_source_triangle_indices(topology, vertex_count);
    if source_triangles.is_empty() {
        return Err(GxClipError::NoSourceTriangles.into());
    }
    let mut vertices = Vec::new();
    let mut output_source_indices = Vec::new();
    for indices in source_triangles {
        if !gx_triangle_components_are_flat(source_vertices, indices, 4..12) {
            return Err(GxExactGeometryError::UnsupportedSourceRaster);
        }
        let reference = indices[0] * TEV_VERTEX_FLOATS;
        let flat_rasters: [f32; 8] = source_vertices[reference + 4..reference + 12]
            .try_into()
            .expect("validated GX raster channel payload");
        let clip_triangle = indices.map(|index| {
            let source =
                &source_vertices[index * TEV_VERTEX_FLOATS..(index + 1) * TEV_VERTEX_FLOATS];
            let mut vertex = [0.0; GX_EXACT_CLIP_PAYLOAD_FLOATS];
            vertex[..4].copy_from_slice(&clip_positions[index]);
            vertex[4..].copy_from_slice(&source[12..]);
            vertex
        });
        for clipped in gx_post_clip_triangle(clip_triangle, cull_mode, projection.viewport()[1])? {
            let projected = [
                gx_exact_raster_vertex(projection.project(clipped[0])?, flat_rasters),
                gx_exact_raster_vertex(projection.project(clipped[1])?, flat_rasters),
                gx_exact_raster_vertex(projection.project(clipped[2])?, flat_rasters),
            ];
            if !gx_projected_triangle_is_supported(&projected) {
                return Err(gx_projected_triangle_error(&projected));
            }
            for vertex in projected {
                vertices.extend_from_slice(&vertex);
            }
            output_source_indices.push(indices);
        }
    }

    Ok(GxExactRasterGeometry {
        vertices,
        source_indices: output_source_indices,
        raster_scissor: projection.raster_scissor(),
    })
}

fn gx_exact_empty_geometry() -> GxExactRasterGeometry {
    GxExactRasterGeometry {
        vertices: Vec::new(),
        source_indices: Vec::new(),
        raster_scissor: GxRasterScissor::new(0, 0, 0, 0, 0, 0)
            .expect("canonical empty GX raster scissor"),
    }
}

fn gx_exact_raster_vertex(
    projected: [f32; GX_EXACT_CLIP_PAYLOAD_FLOATS],
    flat_rasters: [f32; 8],
) -> [f32; TEV_VERTEX_FLOATS] {
    let mut vertex = [0.0; TEV_VERTEX_FLOATS];
    vertex[..4].copy_from_slice(&projected[..4]);
    vertex[4..12].copy_from_slice(&flat_rasters);
    vertex[12..].copy_from_slice(&projected[4..]);
    vertex
}

fn gx_triangle_components_are_flat(
    vertices: &[f32],
    indices: [usize; 3],
    components: impl Iterator<Item = usize>,
) -> bool {
    let reference = indices[0] * TEV_VERTEX_FLOATS;
    components.into_iter().all(|component| {
        let expected = vertices[reference + component].to_bits();
        indices[1..]
            .iter()
            .all(|index| vertices[index * TEV_VERTEX_FLOATS + component].to_bits() == expected)
    })
}

fn gx_projected_triangle_is_supported(vertices: &[[f32; TEV_VERTEX_FLOATS]; 3]) -> bool {
    vertices.iter().all(|vertex| {
        vertex[3] > 0.0
            && (0.0..=EFB_WIDTH as f32).contains(&vertex[0])
            && (0.0..=EFB_HEIGHT as f32).contains(&vertex[1])
            && (0.0..=GX_DEPTH24_MAX as f32).contains(&vertex[2])
    })
}

fn gx_projected_triangle_error(vertices: &[[f32; TEV_VERTEX_FLOATS]; 3]) -> GxExactGeometryError {
    if vertices.iter().any(|vertex| vertex[3] <= 0.0) {
        return GxExactGeometryError::UnsupportedPostClipW;
    }
    if vertices.iter().any(|vertex| {
        !(0.0..=EFB_WIDTH as f32).contains(&vertex[0])
            || !(0.0..=EFB_HEIGHT as f32).contains(&vertex[1])
    }) {
        return GxExactGeometryError::UnsupportedPostClipPosition;
    }
    GxExactGeometryError::UnsupportedPostClipDepth
}

#[cfg(test)]
mod tests;
